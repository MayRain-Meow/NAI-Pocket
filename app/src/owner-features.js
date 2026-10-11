// The app shows the same artist-library UI as the server site, without management tools
// (canManage is false); collection, annotation and rotation workers stay private.
export const artistLibraryAvailable = true;
export const artistAutomationAvailable = false;
export const stormAvailable = false;
export { createArtistLibrary } from '../../public/artist-library.js';
export const createArtistAutomation = () => { throw new Error('此版本未包含画师后台管理工具。'); };
