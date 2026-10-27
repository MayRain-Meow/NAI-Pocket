// The app shows the same artist-library UI as the server site, without management tools
// (canManage is false); collection, annotation and rotation workers stay private.
// Storm (0.7.3) runs on the phone: candidates from the installed 画风数据, the batch in the local queue.
export const artistLibraryAvailable = true;
export const artistAutomationAvailable = false;
export const stormAvailable = true;
export { createArtistLibrary } from '../../public/artist-library.js';
export const createArtistAutomation = () => { throw new Error('此版本未包含画师后台管理工具。'); };
