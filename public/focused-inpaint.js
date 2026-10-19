
export const FOCUSED_SELECTION_MAX_PIXELS = 768 * 768;
export const FOCUSED_WORK_MAX_PIXELS = 1024 * 1024;
export const FOCUSED_SOURCE_MAX_PIXELS = 16_000_000;
export const FOCUSED_IMAGE_MAX_SIDE = 16_384;
export const FOCUSED_IMAGE_MAX_BYTES = 64 * 1024 * 1024;
const fields = ['x', 'y', 'width', 'height', 'sourceWidth', 'sourceHeight'];

export function checkFocusedAbort(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('操作已取消。', 'AbortError');
}

export function assertFocusedDimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width > FOCUSED_IMAGE_MAX_SIDE || height > FOCUSED_IMAGE_MAX_SIDE || width * height > FOCUSED_SOURCE_MAX_PIXELS) {
    throw new Error('图片尺寸无效或过大；框选重绘最多支持 1600 万像素、单边 16384 像素。');
  }
}

export function sanitizeInpaintRegion(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw) || fields.some(key => !Number.isSafeInteger(raw[key]))) {
    throw new Error('重绘框必须使用原图的整数像素坐标，请重新框选。');
  }
  const region = Object.fromEntries(fields.map(key => [key, raw[key]]));
  assertFocusedDimensions(region.sourceWidth, region.sourceHeight);
  if (region.x < 0 || region.y < 0 || region.width < 8 || region.height < 8
    || region.width > region.sourceWidth - region.x || region.height > region.sourceHeight - region.y
    || region.width * region.height > FOCUSED_SELECTION_MAX_PIXELS) {
    throw new Error('重绘框须在原图内，宽高至少 8 像素，面积不超过 768×768 像素。');
  }
  return region;
}

export function focusedInpaintPlan(raw, sourceWidth, sourceHeight) {
  assertFocusedDimensions(sourceWidth, sourceHeight);
  const region = sanitizeInpaintRegion(raw);
  if (!region) throw new Error('请先框选重绘工作区域。');
  if (region.sourceWidth !== sourceWidth || region.sourceHeight !== sourceHeight) {
    throw new Error('原图尺寸已变化，旧重绘框不可使用；请重新框选。');
  }
  const scale = Math.min(Math.sqrt(FOCUSED_WORK_MAX_PIXELS / (region.width * region.height)),
    2048 / region.width, 2048 / region.height);
  let width = Math.max(64, Math.floor(region.width * scale / 64) * 64);
  let height = Math.max(64, Math.floor(region.height * scale / 64) * 64);
  if (width * height > FOCUSED_WORK_MAX_PIXELS) {
    if (width >= height) width = Math.floor(FOCUSED_WORK_MAX_PIXELS / height / 64) * 64;
    else height = Math.floor(FOCUSED_WORK_MAX_PIXELS / width / 64) * 64;
  }
  return { region, sourceWidth, sourceHeight, width, height, workWidth: width, workHeight: height };
}

export function assertFocusedRgba(image) {
  if (!image || typeof image !== 'object') throw new Error('无法读取图片像素。');
  assertFocusedDimensions(image.width, image.height);
  if (!(image.data instanceof Uint8Array || image.data instanceof Uint8ClampedArray)
    || image.data.length !== image.width * image.height * 4) throw new Error('图片 RGBA 数据不完整。');
  return image;
}

export function cropFocusedRgba(image, region) {
  const data = new Uint8Array(region.width * region.height * 4);
  for (let y = 0; y < region.height; y++) {
    const from = ((region.y + y) * image.width + region.x) * 4;
    data.set(image.data.subarray(from, from + region.width * 4), y * region.width * 4);
  }
  return { width: region.width, height: region.height, data };
}

// Pixel-centre mapping is shared by both hosts. Colour resampling uses premultiplied
// alpha only inside the work crop; the retained full-size source is never resampled.
export function resizeFocusedRgba(image, width, height, { nearest = false, signal } = {}) {
  assertFocusedRgba(image);
  assertFocusedDimensions(width, height);
  checkFocusedAbort(signal);
  if (width === image.width && height === image.height) return { width, height, data: new Uint8Array(image.data) };
  const data = new Uint8Array(width * height * 4), source = image.data;
  for (let y = 0; y < height; y++) {
    if ((y & 31) === 0) checkFocusedAbort(signal);
    const sy = Math.max(0, Math.min(image.height - 1, (y + .5) * image.height / height - .5));
    const y0 = Math.floor(sy), y1 = Math.min(image.height - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < width; x++) {
      const target = (y * width + x) * 4;
      if (nearest) {
        const sx = Math.min(image.width - 1, Math.floor((x + .5) * image.width / width));
        const ny = Math.min(image.height - 1, Math.floor((y + .5) * image.height / height));
        const from = (ny * image.width + sx) * 4;
        data.set(source.subarray(from, from + 4), target);
        continue;
      }
      const sx = Math.max(0, Math.min(image.width - 1, (x + .5) * image.width / width - .5));
      const x0 = Math.floor(sx), x1 = Math.min(image.width - 1, x0 + 1), fx = sx - x0;
      const positions = [(y0 * image.width + x0) * 4, (y0 * image.width + x1) * 4,
        (y1 * image.width + x0) * 4, (y1 * image.width + x1) * 4];
      const weights = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy];
      let alpha = 0;
      for (let i = 0; i < 4; i++) alpha += source[positions[i] + 3] * weights[i];
      data[target + 3] = Math.round(alpha);
      for (let channel = 0; channel < 3; channel++) {
        let value = 0;
        for (let i = 0; i < 4; i++) value += source[positions[i] + channel] * source[positions[i] + 3] * weights[i];
        data[target + channel] = alpha ? Math.round(value / alpha) : 0;
      }
    }
  }
  return { width, height, data };
}

export function focusedMaskCoverage(data, offset) {
  // The editor considers alpha >16 painted. Its exported mask flattens white
  // strokes onto opaque black, so alpha*luminance reconstructs that coverage.
  const coverage = data[offset + 3] * Math.max(data[offset], data[offset + 1], data[offset + 2]) / (255 * 255);
  return coverage > 16 / 255 ? coverage : 0;
}
