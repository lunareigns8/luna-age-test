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

tabs.forEach(([tabId, panelId]) => {
  document.querySelector(`#${tabId}`).addEventListener("click", () => {
    tabs.forEach(([t, p]) => {
      document.querySelector(`#${t}`).classList.toggle("active", t === tabId);
      document.querySelector(`#${p}`).classList.toggle("hidden", p !== panelId);
    });
    if (panelId !== "cameraPanel") stopCamera();
    if (panelId === "cameraPanel") warmWorker();
  });
});

window.addEventListener("beforeunload", () => {
  stopCamera();
  terminateWorker();
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopCamera();
});

// Start loading OCR worker when the browser is idle so the first real scan is faster.
const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 700));
idle(() => {
  warmWorker();
  refreshCameraList();
});

els.fileInput.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (file) await handleFile(file);
});

["dragenter", "dragover"].forEach((eventName) => {
  els.dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    els.dropzone.classList.add("dragover");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  els.dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    els.dropzone.classList.remove("dragover");
  });
});

els.dropzone.addEventListener("drop", async (event) => {
  const file = event.dataTransfer.files?.[0];
  if (file) await handleFile(file);
});

els.startCameraBtn.addEventListener("click", startCamera);
els.captureBtn.addEventListener("click", captureCameraFrame);
els.stopCameraBtn.addEventListener("click", stopCamera);
els.torchBtn?.addEventListener("click", toggleTorch);
els.cameraSelect?.addEventListener("change", () => {
  if (cameraStream) startCamera();
});
els.cameraQuality?.addEventListener("change", () => {
  if (cameraStream) startCamera();
});
els.clearBtn.addEventListener("click", clearAll);
els.parseManualBtn.addEventListener("click", () => {
  const value = els.manualMrz.value.trim();
  if (!value) {
    setStatus("Paste one MRZ block first.", 1);
    return;
  }
  runParse(value, { source: "manual" });
});
els.loadSampleBtn.addEventListener("click", () => {
  els.manualMrz.value = SAMPLE_MRZ;
  runParse(SAMPLE_MRZ, { source: "manual" });
});
els.retryBottomBtn.addEventListener("click", async () => lastSource && scanImage(lastSource, "bottom"));
els.retryWideBtn.addEventListener("click", async () => lastSource && scanImage(lastSource, "wide"));

function setStatus(message, progress = null) {
  els.status.textContent = message;
  if (typeof progress === "number") els.progressBar.style.width = `${Math.round(progress * 100)}%`;
}

async function warmWorker() {
  if (workerWarmed || workerPromise) return;
  try {
    workerWarmed = true;
    setStatus("Preparing OCR engine in the background...", 0.04);
    await getWorker();
    if (!isScanning) setStatus("Ready. OCR engine prepared.", 0);
  } catch (error) {
    workerWarmed = false;
    setStatus(`OCR engine could not start: ${error.message}`, 1);
  }
}

async function handleFile(file) {
  try {
    if (!file.type.startsWith("image/")) throw new Error("Only image files are allowed.");
    if (file.size > MAX_FILE_SIZE) throw new Error("Image is too large. Please use an image smaller than 10 MB.");

    setStatus("Loading image...", 0.05);
    const image = await loadImageFromFile(file);
    els.imageMeta.textContent = `${image.naturalWidth}×${image.naturalHeight}, ${(file.size / 1024 / 1024).toFixed(2)} MB`;
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
      reject(new Error("Could not decode image."));
    };
    img.src = url;
  });
}

async function refreshCameraList() {
  if (!navigator.mediaDevices?.enumerateDevices || !els.cameraSelect) return;

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter((device) => device.kind === "videoinput");
    const current = els.cameraSelect.value;

    els.cameraSelect.innerHTML = `<option value="">Auto camera</option>`;
    cameras.forEach((camera, index) => {
      const option = document.createElement("option");
      option.value = camera.deviceId;
      option.textContent = camera.label || `Camera ${index + 1}`;
      els.cameraSelect.appendChild(option);
    });

    if ([...els.cameraSelect.options].some((option) => option.value === current)) {
      els.cameraSelect.value = current;
    }
  } catch {
    // Device labels are hidden until camera permission is granted.
  }
}

function getQualityConstraints() {
  const quality = els.cameraQuality?.value || "balanced";

  if (quality === "fast") {
    return { width: { ideal: 960, max: 960 }, height: { ideal: 540, max: 540 } };
  }

  if (quality === "sharp") {
    return { width: { ideal: 1920, max: 1920 }, height: { ideal: 1080, max: 1080 } };
  }

  return { width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 } };
}

async function startCamera() {
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Camera API is not available. Open the project through http://localhost:5173 or HTTPS, not by double-clicking index.html.");
    }

    stopCamera(false);
    els.captureBtn.disabled = true;
    els.startCameraBtn.disabled = true;
    if (els.torchBtn) els.torchBtn.disabled = true;
    setStatus("Opening camera...", 0.05);

    const deviceId = els.cameraSelect?.value || "";
    const quality = getQualityConstraints();

    const selectedCameraConstraints = deviceId
      ? { deviceId: { exact: deviceId }, ...quality }
      : { facingMode: { ideal: "environment" }, ...quality };

    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: selectedCameraConstraints,
        audio: false,
      });
    } catch {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: quality,
        audio: false,
      });
    }

    currentVideoTrack = cameraStream.getVideoTracks()[0] || null;
    try {
      await currentVideoTrack?.applyConstraints?.({
        advanced: [
          { focusMode: "continuous" },
          { exposureMode: "continuous" },
          { whiteBalanceMode: "continuous" },
        ],
      });
    } catch {
      // Not all browsers/cameras support focus or exposure constraints.
    }

    els.video.srcObject = cameraStream;
    els.video.muted = true;
    els.video.playsInline = true;
    els.video.setAttribute("playsinline", "");
    els.video.setAttribute("webkit-playsinline", "");

    await waitForVideoReady(els.video);
    await refreshCameraList();

    const capabilities = currentVideoTrack?.getCapabilities?.() || {};
    if (els.torchBtn) {
      els.torchBtn.disabled = !capabilities.torch;
      els.torchBtn.textContent = "Toggle light";
    }

    els.captureBtn.disabled = false;
    els.stopCameraBtn.disabled = false;
    els.startCameraBtn.disabled = true;
    els.imageMeta.textContent = `${els.video.videoWidth}×${els.video.videoHeight} camera`;
    setStatus("Camera ready. Fill the blue box with the MRZ lines, then press Capture.", 0);
    warmWorker();
  } catch (error) {
    stopCamera(false);
    els.startCameraBtn.disabled = false;
    setStatus(`Camera problem: ${error.message}`, 1);
  }
}

function waitForVideoReady(video) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Camera opened, but video preview did not start.")), 9000);

    const done = async () => {
      try {
        await video.play();
      } catch {
        // Some browsers start muted video without resolving play().
      }

      if (video.videoWidth > 0 && video.videoHeight > 0) {
        clearTimeout(timeout);
        video.onloadedmetadata = null;
        video.oncanplay = null;
        resolve();
      }
    };

    if (video.readyState >= 2 && video.videoWidth > 0) done();
    else {
      video.onloadedmetadata = done;
      video.oncanplay = done;
    }
  });
}

function stopCamera(showStatus = true) {
  cameraStream?.getTracks().forEach((track) => track.stop());
  cameraStream = null;
  currentVideoTrack = null;
  torchEnabled = false;
  els.video.srcObject = null;
  els.captureBtn.disabled = true;
  els.stopCameraBtn.disabled = true;
  els.startCameraBtn.disabled = false;
  if (els.torchBtn) {
    els.torchBtn.disabled = true;
    els.torchBtn.textContent = "Toggle light";
  }
  if (showStatus) setStatus("Camera stopped.", 0);
}

async function toggleTorch() {
  if (!currentVideoTrack?.applyConstraints) return;

  try {
    torchEnabled = !torchEnabled;
    await currentVideoTrack.applyConstraints({ advanced: [{ torch: torchEnabled }] });
    els.torchBtn.textContent = torchEnabled ? "Light on" : "Toggle light";
  } catch (error) {
    torchEnabled = false;
    setStatus(`Light control is not available on this camera: ${error.message}`, 1);
  }
}

async function captureCameraFrame() {
  if (!cameraStream) {
    setStatus("Camera is not active.", 1);
    return;
  }

  if (!els.video.videoWidth || !els.video.videoHeight) {
    setStatus("Camera preview is not ready yet. Wait one second and try again.", 1);
    return;
  }

  const crop = getVideoCropFromGuide();
  const canvas = document.createElement("canvas");
  canvas.width = crop.sw;
  canvas.height = crop.sh;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(els.video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.sw, crop.sh);

  els.imageMeta.textContent = `${canvas.width}×${canvas.height} camera MRZ crop`;
  await scanImage(canvas, "camera");
}

function getVideoCropFromGuide() {
  const videoRect = els.video.getBoundingClientRect();
  const guide = document.querySelector(".mrz-guide");
  const guideRect = guide.getBoundingClientRect();

  const scaleX = els.video.videoWidth / videoRect.width;
  const scaleY = els.video.videoHeight / videoRect.height;

  const padX = guideRect.width * 0.04;
  const padY = guideRect.height * 0.12;

  let sx = Math.floor((guideRect.left - videoRect.left - padX) * scaleX);
  let sy = Math.floor((guideRect.top - videoRect.top - padY) * scaleY);
  let sw = Math.floor((guideRect.width + padX * 2) * scaleX);
  let sh = Math.floor((guideRect.height + padY * 2) * scaleY);

  sx = Math.max(0, sx);
  sy = Math.max(0, sy);
  sw = Math.max(1, Math.min(els.video.videoWidth - sx, sw));
  sh = Math.max(1, Math.min(els.video.videoHeight - sy, sh));

  return { sx, sy, sw, sh };
}

async function scanImage(source, cropMode = "auto") {
  if (isScanning) return;
  isScanning = true;

  try {
    lastSource = source;
    els.retryBottomBtn.disabled = false;
    els.retryWideBtn.disabled = false;
    setButtonsDisabled(true);

    setStatus("Preparing image...", 0.08);
    const safeSource = drawOriginal(source);

    setStatus("Optimizing MRZ area...", 0.16);
    const processed = preprocessMrzCrop(safeSource, cropMode);

    setStatus("Reading MRZ. This should be faster after the first scan.", 0.28);
    const text = await runOcr(processed);

    runParse(text);
  } catch (error) {
    setStatus(`Scan failed: ${error.message}`, 1);
    els.jsonOutput.textContent = JSON.stringify({ error: error.message }, null, 2);
  } finally {
    isScanning = false;
    setButtonsDisabled(false);
  }
}

function setButtonsDisabled(disabled) {
  els.captureBtn.disabled = disabled || !cameraStream || !els.video.videoWidth;
  els.retryBottomBtn.disabled = disabled || !lastSource;
  els.retryWideBtn.disabled = disabled || !lastSource;
  els.parseManualBtn.disabled = disabled;
}

function drawOriginal(source) {
  const width = source.naturalWidth || source.videoWidth || source.width;
  const height = source.naturalHeight || source.videoHeight || source.height;
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(width, height));

  const canvas = els.originalCanvas;
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function preprocessMrzCrop(source, mode) {
  const srcW = source.width;
  const srcH = source.height;

  let cropY = Math.floor(srcH * 0.56);
  let cropH = Math.floor(srcH * 0.40);

  if (mode === "camera") {
    cropY = 0;
    cropH = srcH;
  } else if (mode === "bottom") {
    cropY = Math.floor(srcH * 0.63);
    cropH = Math.floor(srcH * 0.33);
  } else if (mode === "wide") {
    cropY = Math.floor(srcH * 0.45);
    cropH = Math.floor(srcH * 0.52);
  }

  const canvas = els.processedCanvas;
  const scale = Math.min(2, OCR_TARGET_WIDTH / srcW);
  canvas.width = Math.max(1, Math.floor(srcW * scale));
  canvas.height = Math.max(1, Math.floor(cropH * scale));

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(source, 0, cropY, srcW, cropH, 0, 0, canvas.width, canvas.height);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;

  let sum = 0;
  const gray = new Uint8ClampedArray(data.length / 4);

  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    const value = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    gray[j] = value;
    sum += value;
  }

  const mean = sum / gray.length;
  let variance = 0;
  for (let i = 0; i < gray.length; i++) variance += (gray[i] - mean) ** 2;
  const std = Math.sqrt(variance / gray.length);
  const threshold = Math.min(200, Math.max(95, mean - std * 0.15));

  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    const value = gray[j] > threshold ? 255 : 0;
    data[i] = data[i + 1] = data[i + 2] = value;
    data[i + 3] = 255;
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      if (!window.Tesseract) {
        throw new Error("Tesseract.js did not load. Check internet/CDN or vendor OCR files locally.");
      }

      const worker = await Tesseract.createWorker("eng", 1, {
        logger: (m) => {
          if (m.status && isScanning) {
            setStatus(`${m.status}${m.progress ? ` ${(m.progress * 100).toFixed(0)}%` : ""}`, Math.max(0.28, m.progress || 0.28));
          }
        },
      });

      await worker.setParameters({
        tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<",
        preserve_interword_spaces: "0",
        tessedit_pageseg_mode: "6",
        user_defined_dpi: "300",
      });

      return worker;
    })();
  }

  return workerPromise;
}

async function runOcr(canvas) {
  const worker = await getWorker();
  const result = await worker.recognize(canvas);
  setStatus("OCR finished. Parsing MRZ...", 0.9);
  return result.data.text;
}

async function terminateWorker() {
  if (!workerPromise) return;
  try {
    const worker = await workerPromise;
    await worker.terminate();
  } catch {}
  workerPromise = null;
  workerWarmed = false;
}

function runParse(rawText, options = {}) {
  const normalized = normalizeOcrText(rawText);
  const lines = extractMrzLines(normalized);
  els.ocrText.textContent = lines.length
    ? lines.map((line, index) => `Line ${index + 1}: ${maskMrzLine(line)} (${line.length})`).join("\n")
    : "No MRZ candidate found.";

  try {
    if (!lines.length) {
      throw new Error("No MRZ lines found. Paste the full two passport MRZ lines or three ID-card MRZ lines.");
    }
    const parsed = parseMRZ(lines);
    renderParsed(parsed);
    els.jsonOutput.textContent = JSON.stringify(maskSensitive(parsed), null, 2);
    const sourceLabel = options.source === "manual" ? "Manual MRZ" : "MRZ";
    setStatus(parsed.valid ? `${sourceLabel} parsed successfully. All check digits passed.` : `${sourceLabel} parsed, but one or more check digits failed.`, 1);
  } catch (error) {
    els.parsedOutput.innerHTML = `<p class="invalid">${escapeHtml(error.message)}</p>`;
    els.jsonOutput.textContent = JSON.stringify({ error: error.message, candidateLinesMasked: lines.map(maskMrzLine) }, null, 2);
    setStatus(`Parse failed: ${error.message}`, 1);
  }
}

function maskSensitive(parsed) {
  return {
    format: parsed.format,
    documentType: parsed.documentType,
    issuingCountry: parsed.issuingCountry,
    nationality: parsed.nationality,
    birthDate: parsed.birthDate,
    sex: parsed.sex,
    expirationDate: parsed.expirationDate,
    documentNumberMasked: mask(parsed.documentNumber),
    personalNumberMasked: parsed.personalNumber ? mask(parsed.personalNumber) : "",
    surname: parsed.surname ? "[shown in parsed output]" : "",
    givenNames: parsed.givenNames ? "[shown in parsed output]" : "",
    checks: parsed.checks,
    valid: parsed.valid,
    rawLines: "[hidden]",
  };
}

function maskMrzLine(line) {
  return String(line || "").replace(/[A-Z0-9]/g, "•");
}

function mask(value) {
  const s = String(value || "");
  if (s.length <= 4) return "****";
  return `${s.slice(0, 2)}${"*".repeat(Math.max(0, s.length - 4))}${s.slice(-2)}`;
}

function renderParsed(parsed) {
  const fields = [
    ["Format", parsed.format],
    ["Document type", parsed.documentType],
    ["Issuing country", parsed.issuingCountry],
    ["Document number", mask(parsed.documentNumber)],
    ["Nationality", parsed.nationality],
    ["Surname", parsed.surname],
    ["Given names", parsed.givenNames],
    ["Date of birth", parsed.birthDate],
    ["Sex", parsed.sex],
    ["Expiry date", parsed.expirationDate],
    ["Personal number", parsed.personalNumber ? mask(parsed.personalNumber) : "—"],
    ["Valid", parsed.valid ? "Yes" : "No"],
  ];

  const checks = parsed.checks
    .map((check) => {
      const cls = check.valid ? "valid" : "invalid";
      return `<div class="field"><span class="label">${escapeHtml(check.name)}</span><span class="value ${cls}">${check.valid ? "Pass" : "Fail"} — expected ${check.expected}, got ${check.actual}</span></div>`;
    })
    .join("");

  els.parsedOutput.innerHTML = `
    ${fields.map(([label, value]) => `<div class="field"><span class="label">${escapeHtml(label)}</span><span class="value">${escapeHtml(String(value))}</span></div>`).join("")}
    <h3>Check digits</h3>
    ${checks}
  `;
}

function clearAll() {
  stopCamera(false);
  els.fileInput.value = "";
  els.manualMrz.value = "";
  els.originalCanvas.width = els.originalCanvas.height = 0;
  els.processedCanvas.width = els.processedCanvas.height = 0;
  els.ocrText.textContent = "No MRZ candidate yet.";
  els.parsedOutput.textContent = "No parsed fields yet.";
  els.parsedOutput.className = "cards muted";
  els.jsonOutput.textContent = "{}";
  els.imageMeta.textContent = "";
  els.retryBottomBtn.disabled = true;
  els.retryWideBtn.disabled = true;
  lastSource = null;
  setStatus("Cleared. Ready.", 0);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
