# Document codec worker

This process receives explicitly authorized bytes from Rust. It does not open caller-selected paths, access a business database, load deployment settings, or obtain credentials. Rust owns file access, account checks, cancellation and result delivery.

One JSON request on stdin, followed by EOF:

```json
{ "version": 1, "name": "report.csv", "data": "BASE64_BYTES" }
```

The worker returns one JSON result on stdout. Successful results contain bounded text or a normalized PNG image plus its actual size, format, truncation warnings and dimensions. The original input is limited to 10 MiB. Text is capped at 120,000 UTF-16 characters; PDF extraction reads at most 100 pages; DOCX validation rejects unsafe archive paths, entities and expansion limits. Images are limited to 20 million decoded pixels and normalized to at most 2048 pixels per side. Scanned documents do not acquire invented OCR text.

The Rust supervisor allows two concurrent parsers, clears inherited credentials, applies a 192 MiB JavaScript heap limit and a 20-second deadline, and kills/reaps the process before releasing capacity. Native codec memory is additionally constrained by input/pixel limits; the heap flag is not a total operating-system memory quota. Cancellation and a dropped caller still terminate the child through the independent supervisor.

Use `scripts/build-workers.mjs` to publish this worker together with Pi, MCP and the local computer executor. Production uses `index.mjs` and the generated, pinned npm dependency manifest and lockfile. It does not require `tsx`. Development can run the `.ts` entry with Node 22.19 or newer.

## Validate a native image runtime

Run the synthetic image contract before changing native codec dependencies:

```sh
node --import tsx --test server/workers/document-worker/tests/image-contract.test.ts
```

The suite exercises both source and the actual release worker, including all eight EXIF orientations for PNG, JPEG and WebP, ICC colour conversion, alpha edges, animated-image first-frame behavior, and input/output limits. Expectations use fixed colour matrices and reviewed baselines. Fixtures contain no user images.

Set `OPENBOT_IMAGE_CONTRACT_RUNTIME` to a staged runtime directory to check its installed dependencies instead of the development runtime. Optionally set `OPENBOT_IMAGE_CONTRACT_NODE` to its Node executable. An explicit runtime must resolve Sharp inside that directory; the suite rejects fallback to development dependencies. Passing this suite establishes image behavior, not native redistribution or platform support. Preserve the separate source, license, ABI and packaging checks.

Attachment normalization is a model-input boundary. It does not resize the original downloadable attachment, application icons, avatar masters or development artwork exports.
