import { nativeImage, type NativeImage } from "electron";

const MAX_RELATIVE_ASPECT_RATIO_ERROR = 0.005;

export type InpaintingImageGeometryOptions = {
  sourceImageBytes: Buffer;
  editedImageBytes: Buffer;
  maskBytes?: Buffer;
  decodeImage?: (bytes: Buffer) => NativeImage;
  createFromBitmap?: (buffer: Buffer, options: { width: number; height: number }) => NativeImage;
};

/**
 * Combines raw RGBA byte arrays such that only masked areas are taken from the edited image,
 * leaving unmasked source pixels completely untouched and lossless.
 * mask is expected to be 1-channel (0=unmasked, 255=masked) or 4-channel RGBA (alpha channel used).
 */
export function compositeRawRgbaBuffers(args: {
  sourceRgba: Uint8Array;
  editedRgba: Uint8Array;
  maskBuffer: Uint8Array;
  width: number;
  height: number;
}): Uint8Array {
  const { sourceRgba, editedRgba, maskBuffer, width, height } = args;
  const pixelCount = width * height;
  const output = new Uint8Array(sourceRgba.length);

  const isMaskRgba = maskBuffer.length === pixelCount * 4;

  for (let i = 0; i < pixelCount; i += 1) {
    const pixelOffset = i * 4;
    // Determine mask alpha (0 to 1.0)
    let maskAlpha = 0;
    if (isMaskRgba) {
      // In RGBA masks, opacity or intensity represents mask
      const r = maskBuffer[pixelOffset]!;
      const a = maskBuffer[pixelOffset + 3]!;
      maskAlpha = Math.max(r, a) / 255;
    } else if (i < maskBuffer.length) {
      maskAlpha = maskBuffer[i]! / 255;
    }

    if (maskAlpha <= 0) {
      // 100% untouched original source pixel
      output[pixelOffset] = sourceRgba[pixelOffset]!;
      output[pixelOffset + 1] = sourceRgba[pixelOffset + 1]!;
      output[pixelOffset + 2] = sourceRgba[pixelOffset + 2]!;
      output[pixelOffset + 3] = sourceRgba[pixelOffset + 3]!;
    } else if (maskAlpha >= 1) {
      // 100% edited inpainting pixel
      output[pixelOffset] = editedRgba[pixelOffset]!;
      output[pixelOffset + 1] = editedRgba[pixelOffset + 1]!;
      output[pixelOffset + 2] = editedRgba[pixelOffset + 2]!;
      output[pixelOffset + 3] = editedRgba[pixelOffset + 3]!;
    } else {
      // Feathered boundary blending
      const invAlpha = 1 - maskAlpha;
      output[pixelOffset] = Math.round(sourceRgba[pixelOffset]! * invAlpha + editedRgba[pixelOffset]! * maskAlpha);
      output[pixelOffset + 1] = Math.round(sourceRgba[pixelOffset + 1]! * invAlpha + editedRgba[pixelOffset + 1]! * maskAlpha);
      output[pixelOffset + 2] = Math.round(sourceRgba[pixelOffset + 2]! * invAlpha + editedRgba[pixelOffset + 2]! * maskAlpha);
      output[pixelOffset + 3] = Math.round(sourceRgba[pixelOffset + 3]! * invAlpha + editedRgba[pixelOffset + 3]! * maskAlpha);
    }
  }

  return output;
}

/**
 * Converts a provider response into a PNG that shares the source page's
 * canvas. Providers may return a different resolution, but they must retain
 * the source aspect ratio so that page coordinates and masks remain valid.
 */
export function normalizeInpaintingImageBytes({
  sourceImageBytes,
  editedImageBytes,
  maskBytes,
  decodeImage = (bytes) => nativeImage.createFromBuffer(bytes),
  createFromBitmap = (buf, opts) => nativeImage.createFromBitmap(buf, opts)
}: InpaintingImageGeometryOptions): Buffer {
  const source = decodeInpaintingImage(decodeImage, sourceImageBytes, "source");
  const edited = decodeInpaintingImage(decodeImage, editedImageBytes, "edited");
  const sourceSize = readCanvasSize(source, "source");
  const editedSize = readCanvasSize(edited, "edited");

  const sourceAspectRatio = sourceSize.width / sourceSize.height;
  const editedAspectRatio = editedSize.width / editedSize.height;
  const relativeAspectRatioError =
    Math.abs(editedAspectRatio - sourceAspectRatio) / sourceAspectRatio;
  if (relativeAspectRatioError > MAX_RELATIVE_ASPECT_RATIO_ERROR) {
    throw new Error(
      `Inpainting result aspect ratio mismatch: source ${sourceSize.width}x${sourceSize.height}, ` +
      `edited ${editedSize.width}x${editedSize.height}`
    );
  }

  try {
    const resizedEdited =
      editedSize.width === sourceSize.width && editedSize.height === sourceSize.height
        ? edited
        : edited.resize({
            width: sourceSize.width,
            height: sourceSize.height,
            quality: "best"
          });

    // If maskBytes is provided and bitmap manipulation is available, composite area only
    if (maskBytes && typeof source.toBitmap === "function" && typeof resizedEdited.toBitmap === "function") {
      try {
        const sourceBitmap = source.toBitmap();
        const editedBitmap = resizedEdited.toBitmap();
        const maskImage = decodeInpaintingImage(decodeImage, maskBytes, "edited");
        const resizedMask =
          maskImage.getSize().width === sourceSize.width && maskImage.getSize().height === sourceSize.height
            ? maskImage
            : maskImage.resize({ width: sourceSize.width, height: sourceSize.height, quality: "best" });
        const maskBitmap = typeof resizedMask.toBitmap === "function" ? resizedMask.toBitmap() : null;

        if (maskBitmap && sourceBitmap.length === editedBitmap.length && sourceBitmap.length === maskBitmap.length) {
          const compositedRgba = compositeRawRgbaBuffers({
            sourceRgba: sourceBitmap,
            editedRgba: editedBitmap,
            maskBuffer: maskBitmap,
            width: sourceSize.width,
            height: sourceSize.height
          });
          const compositedImage = createFromBitmap(Buffer.from(compositedRgba), {
            width: sourceSize.width,
            height: sourceSize.height
          });
          return Buffer.from(compositedImage.toPNG());
        }
      } catch {
        // Fall back to resizedEdited if bitmap composite fails
      }
    }

    return Buffer.from(resizedEdited.toPNG());
  } catch (error) {
    throw new Error(
      `Failed to normalize edited inpainting image: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function decodeInpaintingImage(
  decodeImage: (bytes: Buffer) => NativeImage,
  bytes: Buffer,
  label: "source" | "edited"
): NativeImage {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new Error(`Invalid ${label} inpainting image bytes`);
  }
  try {
    return decodeImage(bytes);
  } catch (error) {
    throw new Error(
      `Invalid ${label} inpainting image: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function readCanvasSize(image: NativeImage, label: "source" | "edited") {
  try {
    const size = image.getSize();
    if (
      !Number.isInteger(size.width) ||
      !Number.isInteger(size.height) ||
      size.width <= 0 ||
      size.height <= 0
    ) {
      throw new Error(`Invalid ${label} image canvas dimensions`);
    }
    return size;
  } catch (error) {
    if (error instanceof Error && /Invalid .* canvas dimensions/.test(error.message)) throw error;
    throw new Error(
      `Invalid ${label} image canvas dimensions: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
