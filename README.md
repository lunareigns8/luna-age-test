# Luna Age Test

Privacy-focused test adaptation of the MIT-licensed Passport MRZ Reader by Min SiThu.

This test performs MRZ OCR and checksum validation in the browser and reduces the result to whether the parsed date of birth satisfies an 18+ threshold. It deliberately does not display or persist name, document number, nationality, sex, full DOB, document image, or MRZ text.

## Important limitation
MRZ checksum validation is not proof that a physical identity document is genuine. This build is a technical test only and is not production-ready age/identity verification. A later stage would need document-authenticity controls, liveness, and face-to-document matching.
