// Public browsing uses local preferences and public examples, with no owner tools.
export const artistLibraryAvailable = true;
export const artistAutomationAvailable = false;
export const stormAvailable = false;
export { createArtistBrowser as createArtistLibrary } from '../../public/artist-browser.js';
export const createArtistAutomation = () => { throw new Error('此版本未包含画师后台管理工具。'); };
