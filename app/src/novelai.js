import { Buffer } from 'buffer';
import { createGenerationClient } from '../../service/generation.js';
import { createFocusedInpaintProcessor } from '../../service/focused-inpaint.js';
import { createBrowserFocusedInpaintCodec } from '../../public/focused-inpaint-browser.js';
import { inflateRaw } from './codecs.js';


export function createNativeGenerationClient(options) {
  return createGenerationClient({ ...options, binary: Buffer, inflateRaw,
    focusedInpaint: createFocusedInpaintProcessor(createBrowserFocusedInpaintCodec()) });
}
