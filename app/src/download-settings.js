import { readDownloadPreferences, writeDownloadPreferences } from '../../public/download-preferences.js';

export function downloadSettingsSection({ native, notice, experience = false }) {
  const section = document.createElement('section');
  section.id = 'downloadSettings';
  section.className = 'settings-dialog-section native-download-settings';
  section.innerHTML = `<div class="settings-section-heading"><span class="workspace-eyebrow">// DOWNLOADS</span><h2>图片下载</h2></div>
    <label>元数据<select id="downloadMetadataPreference"><option value="ask">下载时询问</option><option value="original">保留元数据 / 可恢复生成参数</option><option value="clean">移除元数据 / 分享用净图</option></select></label>
    <p class="hint">净图无法再恢复提示词和生成参数。此设置同时用于单张和批量下载。</p>
    <label>保存位置<select id="downloadDestinationPreference"><option value="album">手机相册 / Pictures/${experience ? 'NAI Pocket Experience' : 'NAI Pocket'}</option><option value="folder">指定文件夹 / 授权一次后记住</option><option value="ask">每次选择保存位置</option></select></label>
    <div class="native-download-folder"><button id="chooseDownloadFolder" class="ghost" type="button">选择文件夹</button><span id="downloadFolderName" class="hint"></span></div>
    <p class="hint">批量下载会逐张保存。选择“每次选择”时，批量下载只询问一次目标文件夹。</p>`;
  const metadata = section.querySelector('#downloadMetadataPreference');
  const destination = section.querySelector('#downloadDestinationPreference');
  const folderName = section.querySelector('#downloadFolderName');
  const choose = section.querySelector('#chooseDownloadFolder');
  const sync = async () => {
    const preferences = readDownloadPreferences();
    metadata.value = preferences.metadata; destination.value = preferences.destination;
    try { const folder = await native.getExportFolder(); folderName.textContent = folder.configured ? folder.name : '尚未选择文件夹'; }
    catch { folderName.textContent = '文件夹选择需要安卓设备'; }
  };
  const selectFolder = async () => {
    choose.disabled = true;
    try {
      const result = await native.chooseExportFolder();
      if (result.configured && !result.cancelled) writeDownloadPreferences({ destination: 'folder' });
    } catch (error) { notice(error.message); }
    finally { choose.disabled = false; await sync(); }
  };
  metadata.addEventListener('change', () => writeDownloadPreferences({ metadata: metadata.value }));
  destination.addEventListener('change', async () => {
    if (destination.value === 'folder') {
      try {
        const folder = await native.getExportFolder();
        if (!folder.configured) { await selectFolder(); return; }
      } catch (error) { notice(error.message); await sync(); return; }
    }
    writeDownloadPreferences({ destination: destination.value });
  });
  choose.addEventListener('click', selectFolder);
  document.addEventListener('nai-download-preferences-changed', sync);
  sync();
  return section;
}
