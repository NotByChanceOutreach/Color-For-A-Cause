/**
 * Which failures are known to be temporary (contract C2, used by uploadTrigger.ts).
 *
 * A known temporary failure lets go of the processing lease WITH a refund of the attempt and is rethrown, so
 * Eventarc redelivers the event and the failure never counts toward giving up. Anything not recognised here is an
 * unknown failure: it is rethrown too, but it counts.
 *
 * Recognised:
 *   - Cloud Storage and other HTTP APIs: 408, 429 and every 5xx (ApiError.code, gaxios status / response.status);
 *   - the network: ECONNRESET, ETIMEDOUT, ECONNREFUSED, ECONNABORTED, EPIPE, EAI_AGAIN, ENETUNREACH, EHOSTUNREACH,
 *     ESOCKETTIMEDOUT, undici socket and timeout errors, "socket hang up";
 *   - Firestore (gRPC): UNAVAILABLE (14), DEADLINE_EXCEEDED (4), ABORTED (10) and RESOURCE_EXHAUSTED (8), by numeric
 *     code, by string code ("unavailable"...), or by the "14 UNAVAILABLE: ..." message prefix.
 * The cause chain is followed a few levels, because fetch and gaxios wrap socket errors.
 */

const GRPC_TRANSIENT = new Set([4, 8, 10, 14]);
const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ESOCKETTIMEDOUT",
  "ERR_SOCKET_CONNECTION_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);
const STRING_CODES = new Set(["unavailable", "deadline-exceeded", "aborted", "resource-exhausted"]);
const GRPC_MESSAGE = /^(?:\d+\s+)?(?:UNAVAILABLE|DEADLINE_EXCEEDED|ABORTED|RESOURCE_EXHAUSTED)\b/;
const SOCKET_MESSAGE = /\bsocket hang up\b|\b(?:ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|EAI_AGAIN)\b/;

function isTransientHttp(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

export function isTransientError(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== "object" || depth > 4) return false;
  const e = err as { code?: unknown; status?: unknown; response?: { status?: unknown } | null; message?: unknown; cause?: unknown };
  const code = e.code;
  if (typeof code === "number" && (GRPC_TRANSIENT.has(code) || isTransientHttp(code))) return true;
  if (typeof code === "string") {
    if (NETWORK_CODES.has(code) || STRING_CODES.has(code)) return true;
    if (/^\d{3}$/.test(code) && isTransientHttp(Number(code))) return true;
  }
  for (const status of [e.status, e.response?.status]) {
    if (typeof status === "number" && isTransientHttp(status)) return true;
  }
  const message = typeof e.message === "string" ? e.message : "";
  if (GRPC_MESSAGE.test(message) || SOCKET_MESSAGE.test(message)) return true;
  return isTransientError(e.cause, depth + 1);
}

/**
 * The instance ran out of a resource (memory, threads, /tmp space): sharp / libvips, libjpeg, libpng, Node's own
 * buffers, or the memory-backed /tmp. That says something about this instance at this moment (for example a run that
 * timed out but is still decoding on the same instance), not about the picture, so it is never a refusal. It is not a
 * known temporary failure either (a picture that always exhausts memory must end), so it counts toward the cap.
 * The strings are the ones the shipped libvips, libjpeg and libpng use ("Insufficient memory (case %d)", "Not enough
 * memory", "Memory allocation error", "unable to create thread"), Node's "Array buffer allocation failed", and the
 * errno names and texts of ENOMEM and ENOSPC.
 */
const OUT_OF_RESOURCES =
  /out of memory|bad_alloc|cannot allocate|\bENOMEM\b|memory allocation (?:failed|error)|insufficient memory|not enough memory|unable to create thread|array buffer allocation failed|\bENOSPC\b|no space left on device/i;

export function isOutOfMemory(err: unknown): boolean {
  if (typeof err === "string") return OUT_OF_RESOURCES.test(err);
  if (!err || typeof err !== "object") return false;
  const e = err as { message?: unknown; code?: unknown };
  if (e.code === "ENOMEM" || e.code === "ENOSPC") return true;
  return typeof e.message === "string" && OUT_OF_RESOURCES.test(e.message);
}

/**
 * The only image-processing failures that are about the PICTURE and therefore permanent (uploadTrigger.ts refuses
 * the upload as 'unreadable'; legacy.ts reports it). An explicit allowlist of what sharp 0.35 / libvips say for a
 * file they cannot decode, recorded from real corrupt inputs (see tests/functions/uploadTrigger.test.ts):
 *   - sharp: "Input buffer contains unsupported image format", "Input buffer has corrupt header: ...",
 *     "Input image exceeds pixel limit", "Input Buffer is empty";
 *   - libjpeg (VipsJpeg): premature end, corrupt data, bogus markers and tables, no image, invalid structure;
 *   - libpng / pngload: "vipspng: libpng read error", "pngload_buffer: load error", chunk CRC and IDAT errors;
 *   - libwebp: "webp: unable to parse image"; libheif: invalid input, unsupported codec or feature (iPhone HEVC).
 * Anything else (an unknown sharp error, a bug, a resource problem) is NOT a refusal: it is rethrown and counted, so
 * only the 20 h cap (uploadTrigger.ts GIVE_UP_AFTER_MS) can end it. A resource problem wins over a decode message
 * that wraps it ("Input buffer has corrupt header: VipsJpeg: Insufficient memory (case 4)" is retried).
 */
const UNREADABLE_IMAGE: readonly RegExp[] = [
  /^Input (?:buffer|file) contains unsupported image format\b/i,
  /^Input (?:buffer|file) has corrupt header\b/i,
  /^Input image exceeds pixel limit\b/i,
  /^Input (?:buffer|file) is empty\b/i,
  /\bVipsJpeg: (?:premature end of|Corrupt JPEG data\b|Bogus \w|JPEG datastream contains no image|Invalid JPEG file structure|Not a JPEG file|Unsupported marker type|Unsupported JPEG process|Empty JPEG image|Invalid SOS parameters|Huffman table 0x[0-9a-f]+ was not defined|Quantization table 0x[0-9a-f]+ was not defined|Maximum supported image dimension)/i,
  /\bvipspng: libpng read error\b/i,
  /\bpngload(?:_buffer|_source)?: load error\b/i,
  /\b(?:IDAT|IHDR|PLTE|IEND): (?:CRC error|incorrect header check|invalid distance too far back|Too much image data|Not enough image data)/i,
  /\bwebp: unable to parse image\b/i,
  /\bheif: (?:Invalid input|Unsupported feature|Unsupported codec|Unsupported file-type)\b/i,
];

export function isUnreadableImage(err: unknown): boolean {
  if (isOutOfMemory(err)) return false;
  const message = err instanceof Error ? err.message : "";
  return message !== "" && UNREADABLE_IMAGE.some((re) => re.test(message));
}
