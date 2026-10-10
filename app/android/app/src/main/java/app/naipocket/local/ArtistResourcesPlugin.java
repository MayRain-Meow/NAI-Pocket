package app.naipocket.local;

import android.app.Activity;
import android.content.Intent;
import android.graphics.BitmapFactory;
import android.system.Os;
import android.system.OsConstants;
import android.system.ErrnoException;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.JSArray;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.InputStream;
import java.io.IOException;
import java.io.FileInputStream;
import java.net.HttpURLConnection;
import java.util.Set;
import java.util.HashSet;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONArray;
import org.json.JSONObject;

@CapacitorPlugin(name="ArtistResources")
public class ArtistResourcesPlugin extends Plugin {
    private final ExecutorService worker=Executors.newSingleThreadExecutor();
    private final AtomicBoolean busy=new AtomicBoolean();
    // Process-wide: Activity recreation must not sweep a previous reader's paths.
    // 0 = eligible at cold start; 1 = cleanup in progress; 2 = no more cleanup.
    private static final AtomicInteger maintenanceState=new AtomicInteger();
    private final AtomicBoolean cancelled=new AtomicBoolean();
    private final Set<String> staged=ConcurrentHashMap.newKeySet();
    private volatile HttpURLConnection connection;
    private Runnable maintenanceTask;
    private volatile String phase="idle";
    private volatile String operationId="";
    private volatile long receivedBytes=0,totalBytes=0;
    private void progress(String next,long received,long total) {receivedBytes=received;totalBytes=total;phase=next;}
    private void space(long needed) throws IOException {
        if(getContext().getFilesDir().getUsableSpace()<needed+32L*1024*1024)throw new IOException("可用空间不足，请先释放手机存储空间。");
    }
    private boolean isLink(File file) throws IOException {
        try {return OsConstants.S_ISLNK(Os.lstat(file.getPath()).st_mode);}
        catch(ErrnoException error){if(error.errno==OsConstants.ENOENT)return false;throw new IOException(error);}
    }
    private boolean admitWork(PluginCall call) {
        if(maintenanceState.compareAndSet(0,2)||maintenanceState.get()==2)return true;
        busy.set(false);call.reject("正在整理本机资料，请稍后再试。","BUSY");return false;
    }
    private File directory(String name) throws Exception {
        if(name==null||!name.matches("[a-f0-9-]{36}"))throw new IOException("Invalid staging ID");
        File parent=new File(getContext().getFilesDir(),"artist-resources").getCanonicalFile();
        File result=new File(parent,name).getCanonicalFile();
        if(!result.getParentFile().equals(parent))throw new IOException("Invalid staging path");
        return result;
    }
    private void remove(File directory) throws Exception {
        File[] children=directory.listFiles();
        if(children!=null)for(File file:children) {
            if(!file.getCanonicalFile().getParentFile().equals(directory.getCanonicalFile())||file.isDirectory())throw new IOException("Unexpected staging entry");
            if(!file.delete())throw new IOException("Cannot remove staging entry");
        }
        if(directory.exists()&&!directory.delete())throw new IOException("Cannot remove staging directory");
    }
    @PluginMethod public void importPack(PluginCall call) {
        if(!busy.compareAndSet(false,true)){call.reject("已有资料包正在导入。","BUSY");return;}
        if(!admitWork(call))return;
        operationId=call.getString("operationId","");cancelled.set(false);progress("choose",0,0);
        Intent intent=new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
            .putExtra(Intent.EXTRA_MIME_TYPES,new String[]{"application/zip","application/octet-stream","application/x-zip-compressed"});
        try {startActivityForResult(call,intent,"importResult");}
        catch(Exception error){busy.set(false);call.reject("无法打开文件选择器。",error);}
    }
    @ActivityCallback private void importResult(PluginCall call,ActivityResult result) {
        if(call==null){busy.set(false);return;}
        if(result.getResultCode()!=Activity.RESULT_OK||result.getData()==null||result.getData().getData()==null) {
            busy.set(false);JSObject response=new JSObject();response.put("cancelled",true);call.resolve(response);return;
        }
        worker.execute(()->{
            String name=UUID.randomUUID().toString();File folder=null;
            try {
                space(ArtistPackArchive.MAX_TOTAL);
                folder=directory(name);
                if(folder.exists()||!folder.mkdirs())throw new IOException("Cannot create staging directory");
                JSObject response;
                try(InputStream source=getContext().getContentResolver().openInputStream(result.getData().getData())) {
                    if(source==null)throw new IOException("Cannot read selected file");
                    response=unpack(name,folder,source);
                }
                call.resolve(response);
            } catch(Exception error) {
                if(folder!=null)try{remove(folder);}catch(Exception ignored){}
                failed(call,error);
            } finally {busy.set(false);}
        });
    }
    private JSObject unpack(String name,File folder,InputStream source) throws Exception {
        progress("verify",0,0);
        ArtistPackArchive.Result unpacked=ArtistPackArchive.extract(source,folder,file->{
            BitmapFactory.Options options=new BitmapFactory.Options();options.inJustDecodeBounds=true;
            BitmapFactory.decodeFile(file.getPath(),options);
            return new ArtistPackArchive.ImageInfo(options.outMimeType,options.outWidth,options.outHeight);
        },cancelled::get,bytes->progress("verify",bytes,0));
        if(cancelled.get())throw new java.io.InterruptedIOException();
        JSONArray files=new JSONArray();
        for(ArtistPackArchive.Entry item:unpacked.files) {
            JSONObject file=new JSONObject();file.put("name",item.name);file.put("sha256",item.sha256);file.put("bytes",item.bytes);
            file.put("mime",item.image.mime);file.put("width",item.image.width);file.put("height",item.image.height);files.put(file);
        }
        JSObject response=new JSObject();response.put("directory",name);response.put("manifest",new JSONObject(unpacked.manifest));response.put("files",files);
        staged.add(name);return response;
    }
    private void failed(PluginCall call,Exception error) {
        if(cancelled.get()){JSObject response=new JSObject();response.put("cancelled",true);call.resolve(response);}
        else call.reject("资料包处理失败："+error.getMessage(),error);
    }
    @PluginMethod public void downloadPack(PluginCall call) {
        try {ArtistPackDownload.initial(call.getString("url",""));}
        catch(Exception error){call.reject("请填写 GitHub Release 的 ZIP 下载链接。",error);return;}
        if(!busy.compareAndSet(false,true)){call.reject("已有资料包正在处理。","BUSY");return;}
        if(!admitWork(call))return;
        operationId=call.getString("operationId","");cancelled.set(false);progress("download",0,0);
        worker.execute(()->{
            String name=UUID.randomUUID().toString();File folder=null,archive=null;
            try {
                space(ArtistPackArchive.MAX_TOTAL*2);
                archive=File.createTempFile("nai-artist-",".zip",getContext().getCacheDir());
                ArtistPackDownload.download(call.getString("url"),archive,call.getString("sha256",""),
                    url->(HttpURLConnection)url.openConnection(),new ArtistPackDownload.Control(){
                        public boolean cancelled(){return cancelled.get();}
                        public void connection(HttpURLConnection current){connection=current;}
                    },(received,total)->progress("download",received,total));
                folder=directory(name);
                if(folder.exists()||!folder.mkdirs())throw new IOException("Cannot create staging directory");
                JSObject response;
                try(InputStream source=new FileInputStream(archive)){response=unpack(name,folder,source);}
                call.resolve(response);
            } catch(Exception error) {
                if(folder!=null)try{remove(folder);}catch(Exception ignored){}
                failed(call,error);
            } finally {if(archive!=null)archive.delete();connection=null;busy.set(false);}
        });
    }
    @PluginMethod public void readCatalog(PluginCall call) {
        try {ArtistPackDownload.initial(call.getString("url",""),"json");}
        catch(Exception error){call.reject("请填写 GitHub Release 的 JSON 目录链接。",error);return;}
        if(!busy.compareAndSet(false,true)){call.reject("已有资料正在处理。","BUSY");return;}
        if(!admitWork(call))return;
        operationId=call.getString("operationId","");cancelled.set(false);progress("catalog",0,0);
        worker.execute(()->{
            try {
                String text=ArtistPackDownload.catalog(call.getString("url"),url->(HttpURLConnection)url.openConnection(),
                    new ArtistPackDownload.Control(){
                        public boolean cancelled(){return cancelled.get();}
                        public void connection(HttpURLConnection current){connection=current;}
                    },(received,total)->progress("catalog",received,total));
                JSObject response=new JSObject();response.put("catalog",new JSONObject(text));call.resolve(response);
            } catch(Exception error){failed(call,error);}
            finally {connection=null;busy.set(false);}
        });
    }
    @PluginMethod public void status(PluginCall call) {
        JSObject response=new JSObject();response.put("phase",phase);response.put("receivedBytes",receivedBytes);response.put("totalBytes",totalBytes);
        response.put("cancellable",busy.get()&&!phase.equals("choose"));call.resolve(response);
    }
    @PluginMethod public void recover(PluginCall call) {
        final Set<String> keep;
        try {
            JSArray values=call.getArray("activeDirectories");
            if(values==null)throw new IOException("Missing active directories");
            Set<String> names=new HashSet<>();
            for(int index=0;index<values.length();index++) {
                Object value=values.get(index);if(!(value instanceof String))throw new IOException("Invalid active directory");
                names.add((String)value);
            }
            keep=ArtistPackMaintenance.keepSet(names);
        } catch(Exception error){call.reject("无法核对资料目录，未清理文件。",error);return;}
        // A WebView reload is not a new native session. Never delete old reader
        // paths or staged imports after this plugin has already begun work.
        if(!busy.compareAndSet(false,true)){JSObject result=new JSObject();result.put("skipped",true);call.resolve(result);return;}
        if(!maintenanceState.compareAndSet(0,1)){busy.set(false);JSObject result=new JSObject();result.put("skipped",true);call.resolve(result);return;}
        maintenanceTask=()->{
            try {
                File filesRoot=getContext().getFilesDir().getCanonicalFile();
                ArtistPackMaintenance.Result cleaned=ArtistPackMaintenance.clean(new File(filesRoot,"artist-resources"),getContext().getCacheDir().getCanonicalFile(),keep,this::isLink);
                JSObject result=new JSObject();result.put("directories",cleaned.directories);result.put("files",cleaned.files);
                result.put("reclaimedBytes",cleaned.bytes);result.put("skippedEntries",cleaned.skipped);call.resolve(result);
            } catch(Exception error){call.reject("资料暂存清理未完成。",error);}
            finally {maintenanceState.set(2);busy.set(false);}
        };
        try {worker.execute(maintenanceTask);}
        catch(java.util.concurrent.RejectedExecutionException error){maintenanceState.set(2);busy.set(false);call.reject("资料清理已中断。",error);}
    }
    @PluginMethod public void cancelPack(PluginCall call) {
        if(busy.get()&&operationId.equals(call.getString("operationId",""))){cancelled.set(true);HttpURLConnection current=connection;if(current!=null)current.disconnect();}
        call.resolve();
    }
    @PluginMethod public void retainPack(PluginCall call) {
        staged.remove(call.getString("directory",""));call.resolve();
    }
    @PluginMethod public void discardPack(PluginCall call) {
        String name=call.getString("directory","");
        if(!staged.remove(name)){call.reject("未找到本次暂存资料。");return;}
        worker.execute(()->{try{remove(directory(name));call.resolve();}catch(Exception error){staged.add(name);call.reject("暂存文件清理失败。",error);}});
    }
    @Override protected void handleOnDestroy() {
        cancelled.set(true);HttpURLConnection current=connection;if(current!=null)current.disconnect();
        // A queued task removed before running has no finally block to release
        // the gate. A running task retains the gate until its own finally.
        if(worker.shutdownNow().contains(maintenanceTask))maintenanceState.compareAndSet(1,2);
        super.handleOnDestroy();
    }
}
