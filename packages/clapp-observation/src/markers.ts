import { deflateSync } from "node:zlib";
import type { EvidenceRef } from "@clapp/contracts";
import { canonicalJson, utf8 } from "./canonical.ts";
import { channelOfKind } from "./channels.ts";

/**
 * Redaction marker payloads.
 *
 * When redact() replaces a ref's content, the replacement is a deterministic
 * redaction marker payload of IDENTICAL SHAPE to the evidence it replaces:
 * text and JSON evidence kinds are replaced by the canonical marker document
 * serialized as UTF-8 text (still text / still a JSON document), and the
 * screenshot kind is replaced by a real PNG (a valid 1x1 image carrying the
 * marker document in an iTXt chunk) so the payload remains image/png bytes.
 *
 * The marker document is a pure function of the ORIGINAL ref — anyone holding
 * the redacted bundle can regenerate the exact marker bytes with
 * redactionMarkerPayload(originalRef) and verify that the redacted ref's
 * sha256 is the true digest of those bytes.
 */

/** The closed schema of a redaction marker document. */
export interface RedactionMarkerDocument {
  clapp: "redaction-marker";
  channel: string;
  kind: string;
  source: string;
  originalSha256: string;
  capturedAt: string;
  classification: string;
}

/** Builds the canonical marker document for a ref (pure, deterministic). */
export function redactionMarkerDocument(ref: EvidenceRef): RedactionMarkerDocument {
  return {
    clapp: "redaction-marker",
    channel: channelOfKind(ref.kind),
    kind: ref.kind,
    source: ref.source,
    originalSha256: ref.sha256,
    capturedAt: ref.capturedAt,
    classification: ref.classification,
  };
}

/** Builds the redaction marker payload for a ref: same shape as the original evidence. */
export function redactionMarkerPayload(ref: EvidenceRef): Uint8Array {
  const document = canonicalJson(redactionMarkerDocument(ref));
  if (ref.kind === "screenshot") return pngRedactionMarker(document);
  return utf8(document);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buffer) c = (CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBytes = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, crc]);
}

/**
 * A valid 1x1 RGB PNG whose iTXt chunk (keyword "clapp-redaction") carries
 * the marker document as UTF-8. Deterministic for a given document; zlib's
 * deflateSync is deterministic for fixed input on a fixed runtime.
 */
function pngRedactionMarker(document: string): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); // width
  ihdr.writeUInt32BE(1, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  // iTXt: keyword \0 compressionFlag(0) compressionMethod(0) languageTag \0 translatedKeyword \0 text
  const itxt = Buffer.concat([
    Buffer.from("clapp-redaction", "latin1"),
    Buffer.from([0, 0, 0, 0, 0]),
    Buffer.from(document, "utf8"),
  ]);
  const idat = deflateSync(Buffer.from([0x00, 0x80, 0x80, 0x80])); // filter byte + one gray pixel
  return new Uint8Array(
    Buffer.concat([
      PNG_SIGNATURE,
      pngChunk("IHDR", ihdr),
      pngChunk("iTXt", itxt),
      pngChunk("IDAT", idat),
      pngChunk("IEND", Buffer.alloc(0)),
    ]),
  );
}
