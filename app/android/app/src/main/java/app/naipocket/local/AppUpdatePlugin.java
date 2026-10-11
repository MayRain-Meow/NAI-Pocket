package app.naipocket.local;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

// Self-update from GitHub Releases. Android never installs silently: this only downloads the APK
// into cache/updates, checks it is this app (same package, higher versionCode, same signing
// certificate) and hands it to the system installer, which asks the person to confirm.
@CapacitorPlugin(name="AppUpdate")
public class AppUpdatePlugin extends Plugin {
    private static final String FILE_NAME="NAI-Pocket-update.apk";
    private final ExecutorService worker=Executors.newSingleThreadExecutor();
    private final AtomicBoolean busy=new AtomicBoolean(),cancelled=new AtomicBoolean();
    private volatile HttpURLConnection connection;
    private volatile String phase="idle";
    private volatile long receivedBytes=0,totalBytes=0;

    private File directory(){return new File(getContext().getCacheDir(),"updates");}
    private File target(){return new File(directory(),FILE_NAME);}
    private void clear() {
        File[] files=directory().listFiles();
        if(files!=null)for(File file:files)if(file.isFile()&&!file.delete())file.deleteOnExit();
    }

    // A previous update that is now installed (or older) is useless; a newer one is kept so the
    // person can still install it after granting the permission (Android may restart the app).
    @Override public void load() {
        worker.execute(()->{
            try {
                File file=target();
                if(!file.isFile()){clear();return;}
                PackageInfo archive=archiveInfo(file);
                if(archive==null||versionCode(archive)<=versionCode(installedInfo()))clear();
            } catch(Exception ignored){clear();}
        });
    }

    @PluginMethod public void downloadUpdate(PluginCall call) {
        String url=call.getString("url",""),sha256=call.getString("sha256",""),sha256Url=call.getString("sha256Url","");
        try {
            AppUpdateDownload.initial(url,false);
            if(sha256Url!=null&&!sha256Url.isEmpty())AppUpdateDownload.initial(sha256Url,true);
            if(sha256!=null&&!sha256.isEmpty()&&!sha256.matches("[a-fA-F0-9]{64}"))throw new IOException("Invalid checksum");
        } catch(Exception error){call.reject("更新地址无效。",error);return;}
        if(!busy.compareAndSet(false,true)){call.reject("更新正在下载。","BUSY");return;}
        cancelled.set(false);phase="download";receivedBytes=0;totalBytes=0;
        worker.execute(()->{
            File part=new File(directory(),FILE_NAME+".part");
            try {
                File folder=directory();
                if(!folder.isDirectory()&&!folder.mkdirs())throw new IOException("无法创建更新目录。");
                clear();
                if(getContext().getCacheDir().getUsableSpace()<AppUpdateDownload.MAX_APK+32L*1024*1024)throw new IOException("可用空间不足，请先释放手机存储空间。");
                ArtistPackDownload.Control control=new ArtistPackDownload.Control(){
                    public boolean cancelled(){return cancelled.get();}
                    public void connection(HttpURLConnection current){connection=current;}
                };
                ArtistPackDownload.Opener opener=address->(HttpURLConnection)address.openConnection();
                String expected=sha256==null?"":sha256.toLowerCase(Locale.ROOT);
                if(sha256Url!=null&&!sha256Url.isEmpty()) {
                    String published=AppUpdateDownload.checksum(sha256Url,opener,control);
                    if(!expected.isEmpty()&&!expected.equals(published))throw new IOException("校验值不一致。");
                    expected=published;
                }
                String hash=AppUpdateDownload.download(url,part,expected,opener,control,(received,total)->{receivedBytes=received;totalBytes=total;});
                File file=target();
                if(!part.renameTo(file))throw new IOException("无法保存安装包。");
                JSObject result=new JSObject();result.put("path",file.getAbsolutePath());result.put("sha256",hash);result.put("verified",!expected.isEmpty());
                result.put("bytes",file.length());call.resolve(result);
            } catch(Exception error) {
                part.delete();
                if(cancelled.get()){JSObject result=new JSObject();result.put("cancelled",true);call.resolve(result);}
                else call.reject(message(error,"下载未完成，请稍后重试。"),error);
            } finally {connection=null;phase="idle";busy.set(false);}
        });
    }

    @PluginMethod public void updateStatus(PluginCall call) {
        JSObject result=new JSObject();result.put("phase",phase);result.put("receivedBytes",receivedBytes);result.put("totalBytes",totalBytes);call.resolve(result);
    }

    @PluginMethod public void cancelUpdate(PluginCall call) {
        if(busy.get()){cancelled.set(true);HttpURLConnection current=connection;if(current!=null)current.disconnect();}
        call.resolve();
    }

    @PluginMethod public void installUpdate(PluginCall call) {
        if(busy.get()){call.reject("更新正在下载。","BUSY");return;}
        String path=call.getString("path","");
        worker.execute(()->{
            try {
                File file=target();
                if(path==null||path.isEmpty()||!file.isFile()||!new File(path).getCanonicalFile().equals(file.getCanonicalFile()))throw new IOException("安装包不存在，请重新下载。");
                verify(file);
                Context context=getContext();
                if(Build.VERSION.SDK_INT>=26&&!context.getPackageManager().canRequestPackageInstalls()) {
                    launch(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,Uri.parse("package:"+context.getPackageName())));
                    JSObject result=new JSObject();result.put("needsPermission",true);call.resolve(result);return;
                }
                Uri uri=FileProvider.getUriForFile(context,context.getPackageName()+".fileprovider",file);
                launch(new Intent(Intent.ACTION_VIEW).setDataAndType(uri,"application/vnd.android.package-archive").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION));
                JSObject result=new JSObject();result.put("started",true);call.resolve(result);
            } catch(Exception error) {
                call.reject(message(error,"无法打开系统安装程序。"),error);
            }
        });
    }

    // Messages raised here are already Chinese; transport errors get a short user-facing text.
    private static String message(Exception error,String fallback) {
        String text=error.getMessage()==null?"":error.getMessage();
        if(text.matches("(?s).*[\\u4e00-\\u9fff].*"))return text;
        if(text.contains("checksum"))return "安装包校验失败，已删除。";
        if(text.contains("too large"))return "安装包超过 80 MB 上限。";
        if(text.contains("Untrusted")||text.contains("release asset"))return "更新地址无效。";
        return fallback;
    }

    private void launch(Intent intent) {
        Activity activity=getActivity();
        if(activity!=null)activity.runOnUiThread(()->activity.startActivity(intent));
        else getContext().startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    }

    private int signingFlags(){return Build.VERSION.SDK_INT>=28?PackageManager.GET_SIGNING_CERTIFICATES:legacySignatureFlag();}
    @SuppressWarnings("deprecation") private static int legacySignatureFlag(){return PackageManager.GET_SIGNATURES;}
    private PackageInfo archiveInfo(File file){return getContext().getPackageManager().getPackageArchiveInfo(file.getPath(),signingFlags());}
    private PackageInfo installedInfo() throws Exception {return getContext().getPackageManager().getPackageInfo(getContext().getPackageName(),signingFlags());}
    @SuppressWarnings("deprecation") private static long versionCode(PackageInfo info){return Build.VERSION.SDK_INT>=28?info.getLongVersionCode():info.versionCode;}

    @SuppressWarnings("deprecation")
    private static Set<String> signers(PackageInfo info) throws Exception {
        if(info==null)return new HashSet<>();
        Signature[] values=null;
        if(Build.VERSION.SDK_INT>=28&&info.signingInfo!=null)values=info.signingInfo.getApkContentsSigners();
        if(values==null)values=info.signatures;
        Set<String> result=new HashSet<>();
        if(values!=null)for(Signature signature:values) {
            StringBuilder hex=new StringBuilder();
            for(byte b:MessageDigest.getInstance("SHA-256").digest(signature.toByteArray()))hex.append(String.format(Locale.ROOT,"%02x",b&255));
            result.add(hex.toString());
        }
        return result;
    }

    // Defence in depth: the system installer also refuses a different signer, but checking here
    // gives a clear message and never opens the installer for a foreign or older package.
    private void verify(File file) throws Exception {
        PackageInfo archive=archiveInfo(file),installed=installedInfo();
        if(archive==null)throw new IOException("安装包无法解析，请重新下载。");
        if(!getContext().getPackageName().equals(archive.packageName))throw new IOException("安装包不是 NAI Pocket，已拒绝安装。");
        if(versionCode(archive)<=versionCode(installed))throw new IOException("安装包版本不高于当前版本，已拒绝安装。");
        Set<String> expected=signers(installed),actual=signers(archive);
        if(actual.isEmpty()&&Build.VERSION.SDK_INT>=28)actual=signers(getContext().getPackageManager().getPackageArchiveInfo(file.getPath(),legacySignatureFlag()));
        if(expected.isEmpty()||!expected.equals(actual))throw new IOException("安装包签名与当前应用不一致，已拒绝安装。");
    }

    @Override protected void handleOnDestroy() {
        cancelled.set(true);HttpURLConnection current=connection;if(current!=null)current.disconnect();
        worker.shutdownNow();super.handleOnDestroy();
    }
}
