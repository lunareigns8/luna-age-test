import { parseMRZ, normalizeOcrText, extractMrzLines } from "./mrz-parser.js";

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_IMAGE_SIDE = 1280;
const OCR_TARGET_WIDTH = 960;

const SAMPLE_MRZ = `P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<
L898902C36UTO7408122F1204159ZE184226B<<<<<10`;

const els = {
  fileInput: document.querySelector("#fileInput"),
  dropzone: document.querySelector("#dropzone"),
  originalCanvas: document.querySelector("#originalCanvas"),
  processedCanvas: document.querySelector("#processedCanvas"),
  status: document.querySelector("#status"),
  progressBar: document.querySelector("#progressBar"),
  ocrText: document.querySelector("#ocrText"),
  parsedOutput: document.querySelector("#parsedOutput"),
  jsonOutput: document.querySelector("#jsonOutput"),
  video: document.querySelector("#video"),
  cameraSelect: document.querySelector("#cameraSelect"),
  cameraQuality: document.querySelector("#cameraQuality"),
  startCameraBtn: document.querySelector("#startCameraBtn"),
  captureBtn: document.querySelector("#captureBtn"),
  torchBtn: document.querySelector("#torchBtn"),
  stopCameraBtn: document.querySelector("#stopCameraBtn"),
  clearBtn: document.querySelector("#clearBtn"),
  manualMrz: document.querySelector("#manualMrz"),
  parseManualBtn: document.querySelector("#parseManualBtn"),
  loadSampleBtn: document.querySelector("#loadSampleBtn"),
  retryBottomBtn: document.querySelector("#retryBottomBtn"),
  retryWideBtn: document.querySelector("#retryWideBtn"),
  imageMeta: document.querySelector("#imageMeta"),
};

const tabs = [
  ["uploadTab", "uploadPanel"],
  ["cameraTab", "cameraPanel"],
  ["manualTab", "manualPanel"],
];

let cameraStream = null;
let workerPromise = null;
let lastSource = null;
let isScanning = false;
let workerWarmed = false;
let currentVideoTrack = null;
let torchEnabled = false;

/* ---------- TAB CONTROLS ---------- */

tabs.forEach(([tabId, panelId]) => {
  const tab = document.querySelector(`#${tabId}`);

  tab?.addEventListener("click", () => {
    tabs.forEach(([t, p]) => {
      document.querySelector(`#${t}`)?.classList.toggle("active", t === tabId);
      document.querySelector(`#${p}`)?.classList.toggle("hidden", p !== panelId);
    });

    if (panelId !== "cameraPanel") stopCamera();

    if (panelId === "cameraPanel") {
      warmWorker();
    }
  });
});

window.addEventListener("beforeunload", () => {
  stopCamera();
  terminateWorker();
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopCamera();
});

/* ---------- OCR STARTUP ---------- */

const idle =
  window.requestIdleCallback ||
  ((fn) => setTimeout(fn, 700));

idle(() => {
  warmWorker();
  refreshCameraList();
});

/* ---------- FILE UPLOAD ---------- */

els.fileInput?.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];

  if (file) {
    await handleFile(file);
  }
});

["dragenter", "dragover"].forEach((eventName) => {
  els.dropzone?.addEventListener(eventName, (event) => {
    event.preventDefault();
    els.dropzone.classList.add("dragover");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  els.dropzone?.addEventListener(eventName, (event) => {
    event.preventDefault();
    els.dropzone.classList.remove("dragover");
  });
});

els.dropzone?.addEventListener("drop", async (event) => {
  const file = event.dataTransfer.files?.[0];

  if (file) {
    await handleFile(file);
  }
});

/* ---------- BUTTONS ---------- */

els.startCameraBtn?.addEventListener("click", startCamera);
els.captureBtn?.addEventListener("click", captureCameraFrame);
els.stopCameraBtn?.addEventListener("click", stopCamera);
els.torchBtn?.addEventListener("click", toggleTorch);

els.cameraSelect?.addEventListener("change", () => {
  if (cameraStream) startCamera();
});

els.cameraQuality?.addEventListener("change", () => {
  if (cameraStream) startCamera();
});

els.clearBtn?.addEventListener("click", clearAll);

/* ---------- MANUAL TEST ---------- */

if (els.parseManualBtn) {
  els.parseManualBtn.addEventListener("click", function () {

    try {
      const value = els.manualMrz?.value?.trim() || "";

      if (!value) {
        setStatus("Paste an MRZ first.", 1);
        return;
      }

      setStatus("Parse button clicked. Processing MRZ...", 0.5);

      runParse(value, {
        source: "manual"
      });

    } catch (error) {
      setStatus(
        "Manual parse error: " + error.message,
        1
      );

      console.error(error);
    }
  });
}


if (els.loadSampleBtn) {
  els.loadSampleBtn.addEventListener("click", function () {

    try {
      const sample =
`P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<
L898902C36UTO7408122F1204159ZE184226B<<<<<10`;

      els.manualMrz.value = sample;

      setStatus(
        "Sample loaded. Parsing MRZ...",
        0.5
      );

      runParse(sample, {
        source: "manual"
      });

    } catch (error) {
      setStatus(
        "Sample error: " + error.message,
        1
      );

      console.error(error);
    }
  });
}
els.retryBottomBtn?.addEventListener("click", async () => {
  if (lastSource) {
    await scanImage(lastSource, "bottom");
  }
});

els.retryWideBtn?.addEventListener("click", async () => {
  if (lastSource) {
    await scanImage(lastSource, "wide");
  }
});

/* ---------- STATUS ---------- */

function setStatus(message, progress = null) {
  if (els.status) {
    els.status.textContent = message;
  }

  if (
    typeof progress === "number" &&
    els.progressBar
  ) {
    els.progressBar.style.width =
      `${Math.round(progress * 100)}%`;
  }
}

/* ---------- OCR WORKER ---------- */

async function warmWorker() {
  if (workerWarmed || workerPromise) return;

  try {
    workerWarmed = true;

    setStatus(
      "Preparing OCR engine in the background...",
      0.04
    );

    await getWorker();

    if (!isScanning) {
      setStatus(
        "Ready. OCR engine prepared.",
        0
      );
    }
  } catch (error) {
    workerWarmed = false;

    setStatus(
      `OCR engine could not start: ${error.message}`,
      1
    );
  }
}

/* ---------- FILE HANDLING ---------- */

async function handleFile(file) {
  try {
    if (!file.type.startsWith("image/")) {
      throw new Error(
        "Only image files are allowed."
      );
    }

    if (file.size > MAX_FILE_SIZE) {
      throw new Error(
        "Image is too large. Please use an image smaller than 10 MB."
      );
    }

    setStatus("Loading image...", 0.05);

    const image = await loadImageFromFile(file);

    if (els.imageMeta) {
      els.imageMeta.textContent =
        `${image.naturalWidth}×${image.naturalHeight}, ` +
        `${(file.size / 1024 / 1024).toFixed(2)} MB`;
    }

    await scanImage(image, "auto");
  } catch (error) {
    setStatus(error.message, 1);
  }
}

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();

    img.decoding = "async";

    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);

      reject(
        new Error("Could not decode image.")
      );
    };

    img.src = url;
  });
}

/* ---------- CAMERA ---------- */

async function refreshCameraList() {
  if (
    !navigator.mediaDevices?.enumerateDevices ||
    !els.cameraSelect
  ) {
    return;
  }

  try {
    const devices =
      await navigator.mediaDevices.enumerateDevices();

    const cameras =
      devices.filter(
        (device) => device.kind === "videoinput"
      );

    const current =
      els.cameraSelect.value;

    els.cameraSelect.innerHTML =
      `<option value="">Auto camera</option>`;

    cameras.forEach((camera, index) => {
      const option =
        document.createElement("option");

      option.value = camera.deviceId;

      option.textContent =
        camera.label ||
        `Camera ${index + 1}`;

      els.cameraSelect.appendChild(option);
    });

    if (
      [...els.cameraSelect.options].some(
        (option) => option.value === current
      )
    ) {
      els.cameraSelect.value = current;
    }
  } catch {
    /* Permission may not have been granted yet */
  }
}

function getQualityConstraints() {
  const quality =
    els.cameraQuality?.value || "balanced";

  if (quality === "fast") {
    return {
      width: { ideal: 960, max: 960 },
      height: { ideal: 540, max: 540 }
    };
  }

  if (quality === "sharp") {
    return {
      width: { ideal: 1920, max: 1920 },
      height: { ideal: 1080, max: 1080 }
    };
  }

  return {
    width: { ideal: 1280, max: 1280 },
    height: { ideal: 720, max: 720 }
  };
}

async function startCamera() {
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        "Camera API is not available."
      );
    }

    stopCamera(false);

    if (els.captureBtn) {
      els.captureBtn.disabled = true;
    }

    if (els.startCameraBtn) {
      els.startCameraBtn.disabled = true;
    }

    if (els.torchBtn) {
      els.torchBtn.disabled = true;
    }

    setStatus("Opening camera...", 0.05);

    const deviceId =
      els.cameraSelect?.value || "";

    const quality =
      getQualityConstraints();

    const selectedCameraConstraints =
      deviceId
        ? {
            deviceId: { exact: deviceId },
            ...quality
          }
        : {
            facingMode: {
              ideal: "environment"
            },
            ...quality
          };

    try {
      cameraStream =
        await navigator.mediaDevices.getUserMedia({
          video: selectedCameraConstraints,
          audio: false
        });
    } catch {
      cameraStream =
        await navigator.mediaDevices.getUserMedia({
          video: quality,
          audio: false
        });
    }

    currentVideoTrack =
      cameraStream.getVideoTracks()[0] || null;

    els.video.srcObject = cameraStream;
    els.video.muted = true;
    els.video.playsInline = true;

    els.video.setAttribute(
      "playsinline",
      ""
    );

    await waitForVideoReady(els.video);

    await refreshCameraList();

    if (els.captureBtn) {
      els.captureBtn.disabled = false;
    }

    if (els.stopCameraBtn) {
      els.stopCameraBtn.disabled = false;
    }

    if (els.startCameraBtn) {
      els.startCameraBtn.disabled = true;
    }

    if (els.imageMeta) {
      els.imageMeta.textContent =
        `${els.video.videoWidth}×${els.video.videoHeight} camera`;
    }

    setStatus(
      "Camera ready. Fill the MRZ guide and press Capture.",
      0
    );

    warmWorker();
  } catch (error) {
    stopCamera(false);

    if (els.startCameraBtn) {
      els.startCameraBtn.disabled = false;
    }

    setStatus(
      `Camera problem: ${error.message}`,
      1
    );
  }
}

function waitForVideoReady(video) {
  return new Promise((resolve, reject) => {
    const timeout =
      setTimeout(() => {
        reject(
          new Error(
            "Camera opened, but video preview did not start."
          )
        );
      }, 9000);

    const done = async () => {
      try {
        await video.play();
      } catch {}

      if (
        video.videoWidth > 0 &&
        video.videoHeight > 0
      ) {
        clearTimeout(timeout);
        resolve();
      }
    };

    if (video.readyState >= 2) {
      done();
    } else {
      video.onloadedmetadata = done;
    }
  });
}

function stopCamera(updateStatus = true) {
  if (cameraStream) {
    cameraStream
      .getTracks()
      .forEach((track) => track.stop());
  }

  cameraStream = null;
  currentVideoTrack = null;
  torchEnabled = false;

  if (els.video) {
    els.video.srcObject = null;
  }

  if (els.captureBtn) {
    els.captureBtn.disabled = true;
  }

  if (els.stopCameraBtn) {
    els.stopCameraBtn.disabled = true;
  }

  if (els.startCameraBtn) {
    els.startCameraBtn.disabled = false;
  }

  if (updateStatus) {
    setStatus("Camera stopped.", 0);
  }
}

async function toggleTorch() {
  if (!currentVideoTrack) return;

  try {
    torchEnabled = !torchEnabled;

    await currentVideoTrack.applyConstraints({
      advanced: [{
        torch: torchEnabled
      }]
    });
  } catch {
    torchEnabled = false;
  }
}

async function captureCameraFrame() {
  if (
    !els.video?.videoWidth ||
    !els.video?.videoHeight
  ) {
    return;
  }

  const canvas =
    document.createElement("canvas");

  canvas.width =
    els.video.videoWidth;

  canvas.height =
    els.video.videoHeight;

  canvas
    .getContext("2d")
    .drawImage(
      els.video,
      0,
      0,
      canvas.width,
      canvas.height
    );

  if (els.imageMeta) {
    els.imageMeta.textContent =
      `${canvas.width}×${canvas.height} camera capture`;
  }

  await scanImage(
    canvas,
    "camera"
  );
}

/* ---------- IMAGE SCANNING ---------- */

async function scanImage(source, cropMode = "auto") {
  if (isScanning) return;

  isScanning = true;

  try {
    lastSource = source;

    if (els.retryBottomBtn) {
      els.retryBottomBtn.disabled = false;
    }

    if (els.retryWideBtn) {
      els.retryWideBtn.disabled = false;
    }

    setButtonsDisabled(true);

    setStatus(
      "Preparing image...",
      0.08
    );

    const safeSource =
      drawOriginal(source);

    setStatus(
      "Optimizing MRZ area...",
      0.16
    );

    const processed =
      preprocessMrzCrop(
        safeSource,
        cropMode
      );

    setStatus(
      "Reading MRZ...",
      0.28
    );

    const text =
      await runOcr(processed);

    runParse(text);
  } catch (error) {
    setStatus(
      `Scan failed: ${error.message}`,
      1
    );

    if (els.jsonOutput) {
      els.jsonOutput.textContent =
        JSON.stringify(
          { error: error.message },
          null,
          2
        );
    }
  } finally {
    isScanning = false;
    setButtonsDisabled(false);
  }
}

function setButtonsDisabled(disabled) {
  if (els.captureBtn) {
    els.captureBtn.disabled =
      disabled ||
      !cameraStream ||
      !els.video.videoWidth;
  }

  if (els.retryBottomBtn) {
    els.retryBottomBtn.disabled =
      disabled || !lastSource;
  }

  if (els.retryWideBtn) {
    els.retryWideBtn.disabled =
      disabled || !lastSource;
  }

  if (els.parseManualBtn) {
    els.parseManualBtn.disabled =
      disabled;
  }
}

function drawOriginal(source) {
  const width =
    source.naturalWidth ||
    source.videoWidth ||
    source.width;

  const height =
    source.naturalHeight ||
    source.videoHeight ||
    source.height;

  const scale =
    Math.min(
      1,
      MAX_IMAGE_SIDE /
        Math.max(width, height)
    );

  const canvas =
    els.originalCanvas;

  canvas.width =
    Math.round(width * scale);

  canvas.height =
    Math.round(height * scale);

  const ctx =
    canvas.getContext(
      "2d",
      { willReadFrequently: true }
    );

  ctx.drawImage(
    source,
    0,
    0,
    canvas.width,
    canvas.height
  );

  return canvas;
}

function preprocessMrzCrop(source, mode) {
  const srcW = source.width;
  const srcH = source.height;

  let cropY =
    Math.floor(srcH * 0.56);

  let cropH =
    Math.floor(srcH * 0.40);

  if (mode === "camera") {
    cropY = 0;
    cropH = srcH;
  }

  if (mode === "bottom") {
    cropY =
      Math.floor(srcH * 0.63);

    cropH =
      Math.floor(srcH * 0.33);
  }

  if (mode === "wide") {
    cropY =
      Math.floor(srcH * 0.45);

    cropH =
      Math.floor(srcH * 0.52);
  }

  const canvas =
    els.processedCanvas;

  const scale =
    Math.min(
      2,
      OCR_TARGET_WIDTH / srcW
    );

  canvas.width =
    Math.max(
      1,
      Math.floor(srcW * scale)
    );

  canvas.height =
    Math.max(
      1,
      Math.floor(cropH * scale)
    );

  const ctx =
    canvas.getContext(
      "2d",
      { willReadFrequently: true }
    );

  ctx.imageSmoothingEnabled = false;

  ctx.drawImage(
    source,
    0,
    cropY,
    srcW,
    cropH,
    0,
    0,
    canvas.width,
    canvas.height
  );

  return canvas;
}

/* ---------- TESSERACT ---------- */

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      if (!window.Tesseract) {
        throw new Error(
          "Tesseract.js did not load."
        );
      }

      const worker =
        await Tesseract.createWorker(
          "eng",
          1
        );

      await worker.setParameters({
        tessedit_char_whitelist:
          "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<",
        preserve_interword_spaces: "0",
        tessedit_pageseg_mode: "6",
        user_defined_dpi: "300"
      });

      return worker;
    })();
  }

  return workerPromise;
}

async function runOcr(canvas) {
  const worker =
    await getWorker();

  const result =
    await worker.recognize(canvas);

  setStatus(
    "OCR finished. Parsing MRZ...",
    0.9
  );

  return result.data.text;
}

async function terminateWorker() {
  if (!workerPromise) return;

  try {
    const worker =
      await workerPromise;

    await worker.terminate();
  } catch {}

  workerPromise = null;
  workerWarmed = false;
}

/* ==========================================
   MRZ AGE CHECK
   ========================================== */

function runParse(rawText, options = {}) {
  try {
    const normalized =
      normalizeOcrText(rawText);

    const lines =
      extractMrzLines(normalized);

    if (!lines.length) {
      throw new Error(
        "No MRZ lines found. Make sure the complete machine-readable zone is visible."
      );
    }

    const parsed =
      parseMRZ(lines);

    const adult =
      parsed.valid &&
      isAtLeast18(parsed.birthDate);

    renderAgeResult(
      parsed.valid,
      adult
    );

    /*
      IMPORTANT:
      Only PASS/FAIL information is retained.
      No identity fields are written here.
    */

    if (els.jsonOutput) {
      els.jsonOutput.textContent =
        JSON.stringify(
          {
            mrzValid:
              Boolean(parsed.valid),

            age18Plus:
              Boolean(adult)
          },
          null,
          2
        );
    }

    const sourceLabel =
      options.source === "manual"
        ? "Manual MRZ"
        : "MRZ";

    if (!parsed.valid) {
      setStatus(
        `${sourceLabel} read, but validation failed.`,
        1
      );
    } else if (adult) {
      setStatus(
        `${sourceLabel} validated. 18+ age requirement passed.`,
        1
      );
    } else {
      setStatus(
        `${sourceLabel} validated. 18+ age requirement not met.`,
        1
      );
    }
  } catch (error) {
    if (els.parsedOutput) {
      els.parsedOutput.innerHTML = `
        <div class="result-box">
          <h3 class="result-fail">
            AGE CHECK NOT COMPLETED
          </h3>

          <p class="result-note">
            ${escapeHtml(error.message)}
          </p>
        </div>
      `;
    }

    if (els.jsonOutput) {
      els.jsonOutput.textContent =
        JSON.stringify(
          { verified: false },
          null,
          2
        );
    }

    setStatus(
      `Age check failed: ${error.message}`,
      1
    );
  } finally {
    /*
      Privacy cleanup happens AFTER the
      result has been calculated.
    */

    purgeSensitiveArtifacts();

    /*
      Automatically move the user to the
      PASS/FAIL result.
    */

    requestAnimationFrame(() => {
      els.parsedOutput?.scrollIntoView({
        behavior: "smooth",
        block: "center"
      });
    });
  }
}

/* ---------- AGE CALCULATION ---------- */

function isAtLeast18(isoBirthDate) {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})$/.exec(
      String(isoBirthDate || "")
    );

  if (!match) {
    return false;
  }

  const year =
    Number(match[1]);

  const month =
    Number(match[2]);

  const day =
    Number(match[3]);

  const today =
    new Date();

  let age =
    today.getFullYear() - year;

  const beforeBirthday =
    today.getMonth() + 1 < month ||
    (
      today.getMonth() + 1 === month &&
      today.getDate() < day
    );

  if (beforeBirthday) {
    age -= 1;
  }

  return (
    age >= 18 &&
    age <= 120
  );
}

/* ---------- RESULT ---------- */

function renderAgeResult(
  mrzValid,
  adult
) {
  if (!els.parsedOutput) return;

  if (!mrzValid) {
    els.parsedOutput.innerHTML = `
      <div class="result-box">

        <h3 class="result-fail">
          MRZ VALIDATION FAILED
        </h3>

        <p class="result-note">
          The document data could not be
          validated, so no age result
          was accepted.
        </p>

      </div>
    `;

    return;
  }

  if (adult) {
    els.parsedOutput.innerHTML = `
      <div class="result-box">

        <h3 class="result-pass">
          ✓ 18+ AGE CHECK PASSED
        </h3>

        <p class="result-note">
          MRZ checks passed and the
          date of birth meets the
          18+ requirement.
        </p>

        <p class="result-note">
          Temporary document image,
          MRZ text and extracted
          identity data have been
          cleared from this page.
        </p>

      </div>
    `;
  } else {
    els.parsedOutput.innerHTML = `
      <div class="result-box">

        <h3 class="result-fail">
          18+ AGE CHECK NOT PASSED
        </h3>

        <p class="result-note">
          The MRZ was valid, but the
          18+ requirement was not met.
        </p>

        <p class="result-note">
          Temporary document image,
          MRZ text and extracted
          identity data have been
          cleared from this page.
        </p>

      </div>
    `;
  }
}

/* ---------- PRIVACY CLEANUP ---------- */

function purgeSensitiveArtifacts() {
  if (els.fileInput) {
    els.fileInput.value = "";
  }

  if (els.manualMrz) {
    els.manualMrz.value = "";
  }

  if (els.originalCanvas) {
    els.originalCanvas.width = 0;
    els.originalCanvas.height = 0;
  }

  if (els.processedCanvas) {
    els.processedCanvas.width = 0;
    els.processedCanvas.height = 0;
  }

  if (els.ocrText) {
    els.ocrText.textContent =
      "Cleared after age calculation.";
  }

  if (els.imageMeta) {
    els.imageMeta.textContent = "";
  }

  lastSource = null;
}

/* ---------- CLEAR EVERYTHING ---------- */

function clearAll() {
  stopCamera(false);

  if (els.fileInput) {
    els.fileInput.value = "";
  }

  if (els.manualMrz) {
    els.manualMrz.value = "";
  }

  if (els.originalCanvas) {
    els.originalCanvas.width = 0;
    els.originalCanvas.height = 0;
  }

  if (els.processedCanvas) {
    els.processedCanvas.width = 0;
    els.processedCanvas.height = 0;
  }

  if (els.ocrText) {
    els.ocrText.textContent =
      "No MRZ candidate yet.";
  }

  if (els.parsedOutput) {
    els.parsedOutput.textContent =
      "No verification result yet.";
  }

  if (els.jsonOutput) {
    els.jsonOutput.textContent = "{}";
  }

  if (els.imageMeta) {
    els.imageMeta.textContent = "";
  }

  if (els.retryBottomBtn) {
    els.retryBottomBtn.disabled = true;
  }

  if (els.retryWideBtn) {
    els.retryWideBtn.disabled = true;
  }

  lastSource = null;

  setStatus(
    "Cleared. Ready.",
    0
  );
}

/* ---------- HTML SAFETY ---------- */

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
