/**
 * Detecção de imagem por magic bytes — fonte de verdade do tipo.
 * MIME declarado pelo cliente não autoriza o conteúdo.
 */

import { DEMANDAS_MAX_PHOTO_BYTES } from "./demandas-policy.ts";

export const DEMANDAS_DETECTED_MIME = ["image/jpeg", "image/png", "image/webp"] as const;
export type DemandasDetectedMime = (typeof DEMANDAS_DETECTED_MIME)[number];

const JPEG_SOI = [0xff, 0xd8, 0xff] as const;
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

export type DemandasImageDetection =
  | { ok: true; mime: DemandasDetectedMime; ext: "jpg" | "png" | "webp" }
  | { ok: false; code: "demandas_mime_invalido" | "demandas_arquivo_grande" | "demandas_arquivo_obrigatorio" };

function startsWith(bytes: Uint8Array, sig: readonly number[]): boolean {
  if (bytes.length < sig.length) {
    return false;
  }
  return sig.every((value, index) => bytes[index] === value);
}

function isWebp(bytes: Uint8Array): boolean {
  if (bytes.length < 12) {
    return false;
  }
  const riff = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
  const webp = bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  return riff && webp;
}

function looksLikeMarkup(bytes: Uint8Array): boolean {
  let offset = 0;
  while (offset < bytes.length && (bytes[offset] === 0x20 || bytes[offset] === 0x09 || bytes[offset] === 0x0a || bytes[offset] === 0x0d)) {
    offset += 1;
  }
  if (offset >= bytes.length || bytes[offset] !== 0x3c) {
    return false;
  }
  const head = String.fromCharCode(...bytes.slice(offset, Math.min(bytes.length, offset + 64))).toLowerCase();
  return (
    head.startsWith("<svg") ||
    head.startsWith("<?xml") ||
    head.startsWith("<!doctype") ||
    head.startsWith("<html") ||
    head.startsWith("<script") ||
    head.startsWith("<img")
  );
}

export function detectDemandasImageBytes(
  bytes: Uint8Array | null | undefined,
  maxBytes: number = DEMANDAS_MAX_PHOTO_BYTES,
): DemandasImageDetection {
  if (!bytes || bytes.byteLength <= 0) {
    return { ok: false, code: "demandas_arquivo_obrigatorio" };
  }
  if (bytes.byteLength > maxBytes) {
    return { ok: false, code: "demandas_arquivo_grande" };
  }
  if (looksLikeMarkup(bytes)) {
    return { ok: false, code: "demandas_mime_invalido" };
  }
  if (startsWith(bytes, JPEG_SOI)) {
    return { ok: true, mime: "image/jpeg", ext: "jpg" };
  }
  if (startsWith(bytes, PNG_SIG)) {
    return { ok: true, mime: "image/png", ext: "png" };
  }
  if (isWebp(bytes)) {
    return { ok: true, mime: "image/webp", ext: "webp" };
  }
  return { ok: false, code: "demandas_mime_invalido" };
}

export function estimateBase64DecodedBytes(base64: string): number {
  const padded = base64.replace(/\s/g, "");
  const padding = padded.endsWith("==") ? 2 : padded.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((padded.length * 3) / 4) - padding);
}
