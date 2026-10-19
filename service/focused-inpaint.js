import { FOCUSED_IMAGE_MAX_BYTES, assertFocusedRgba, checkFocusedAbort, focusedInpaintPlan,
  cropFocusedRgba, resizeFocusedRgba, focusedMaskCoverage } from '../public/focused-inpaint.js';

function checkBytes(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > FOCUSED_IMAGE_MAX_BYTES) {
    throw new Error('重绘图片文件为空或超过 64 MiB。');
  }
}

export function createFocusedInpaintProcessor({ decode, encode } = {}) {
  if (typeof decode !== 'function' || typeof encode !== 'function') throw new TypeError('Focused inpaint requires decode and encode ports.');
  const ownedPreparations = new WeakSet();
  return {
    async prepare(sourceBytes, maskBytes, region, { signal } = {}) {
      checkFocusedAbort(signal); checkBytes(sourceBytes); checkBytes(maskBytes);
      const source = assertFocusedRgba(await decode(sourceBytes, { signal }));
      checkFocusedAbort(signal);
      const plan = focusedInpaintPlan(region, source.width, source.height);
      const mask = assertFocusedRgba(await decode(maskBytes, { signal }));
      checkFocusedAbort(signal);
      if (source.width !== mask.width || source.height !== mask.height) throw new Error('蒙版尺寸与原图不同，请重新绘制。');
      let selected = 0;
      for (let y = 0; y < source.height; y++) {
        if ((y & 31) === 0) checkFocusedAbort(signal);
        for (let x = 0; x < source.width; x++) {
          if (!focusedMaskCoverage(mask.data, (y * source.width + x) * 4)) continue;
          if (x < plan.region.x || x >= plan.region.x + plan.region.width || y < plan.region.y || y >= plan.region.y + plan.region.height) {
            throw new Error('蒙版还有涂抹位于重绘框外，请扩大重绘框或擦除框外涂抹。');
          }
          selected++;
        }
      }
      if (!selected) throw new Error('重绘蒙版为空，请先涂抹要修改的位置。');
      const work = resizeFocusedRgba(cropFocusedRgba(source, plan.region), plan.width, plan.height, { signal });
      const workMask = resizeFocusedRgba(cropFocusedRgba(mask, plan.region), plan.width, plan.height, { nearest: true, signal });
      // The upload uses black/white selection, while original mask coverage remains
      // authoritative for final writes. Never expand that coverage beyond its edge.
      for (let i = 0; i < workMask.data.length; i += 4) {
        const value = focusedMaskCoverage(workMask.data, i) > 0 ? 255 : 0;
        workMask.data[i] = workMask.data[i + 1] = workMask.data[i + 2] = value;
        workMask.data[i + 3] = 255;
      }
      const imageBytes = await encode(work, { signal });
      const maskImageBytes = await encode(workMask, { signal });
      checkFocusedAbort(signal); checkBytes(imageBytes); checkBytes(maskImageBytes);
      const prepared = { plan, imageBytes, maskBytes: maskImageBytes, source, mask };
      ownedPreparations.add(prepared);
      return prepared;
    },
    async composite(generatedBytes, prepared, { signal } = {}) {
      checkFocusedAbort(signal); checkBytes(generatedBytes);
      if (!prepared || !ownedPreparations.has(prepared)) throw new Error('重绘上下文无效，请重新提交。');
      const generated = assertFocusedRgba(await decode(generatedBytes, { signal }));
      checkFocusedAbort(signal);
      const { plan, source, mask } = prepared, region = plan.region;
      if (generated.width !== plan.width || generated.height !== plan.height) {
        throw new Error('重绘结果尺寸与请求不一致，已保留原图。');
      }
      const patch = resizeFocusedRgba(generated, region.width, region.height, { signal });
      
      // Copy the untouched original, then write ONLY original painted pixels. This
      // preserves hidden RGB and alpha outside the mask, even inside the work crop.
      const output = { width: source.width, height: source.height, data: new Uint8Array(source.data) };
      for (let y = 0; y < region.height; y++) {
        if ((y & 31) === 0) checkFocusedAbort(signal);
        for (let x = 0; x < region.width; x++) {
          const to = ((region.y + y) * source.width + region.x + x) * 4;
          const coverage = focusedMaskCoverage(mask.data, to);
          if (!coverage) continue;
          const from = (y * region.width + x) * 4;
          for (let c = 0; c < 4; c++) output.data[to + c] = Math.round(source.data[to + c] * (1 - coverage) + patch.data[from + c] * coverage);
        }
      }
      checkFocusedAbort(signal);
      const bytes = await encode(output, { signal });
      checkFocusedAbort(signal); checkBytes(bytes);
      return bytes;
    }
  };
}
