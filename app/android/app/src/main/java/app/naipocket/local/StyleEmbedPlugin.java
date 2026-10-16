package app.naipocket.local;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtSession;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.nio.FloatBuffer;
import java.util.Collections;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

// 以图找画师 in the app (0.6.0): the website's CLIP ViT-L/14 vision model, downloaded once from a
// GitHub Release (checksum required) into filesDir/style-model/vision.onnx, embeds one picture at a
// time on the phone. The session stays loaded while pictures are searched and is released after
// IDLE_MS, like the server's model process. Preprocessing matches the server: shortest edge to 224,
// centre crop, CLIP mean/std. Nothing leaves the phone.
@CapacitorPlugin(name="StyleEmbed")
public class StyleEmbedPlugin extends Plugin {
    static final long MAX_MODEL=512L*1024*1024;
    private static final int SIZE=224;
    private static final long IDLE_MS=3*60*1000;
    private static final float[] MEAN={0.48145466f,0.4578275f,0.40821073f}, STD={0.26862954f,0.26130258f,0.27577711f};
    private final ExecutorService worker=Executors.newSingleThreadExecutor();
    private final Handler idle=new Handler(Looper.getMainLooper());
    private final AtomicBoolean downloading=new AtomicBoolean(), cancelled=new AtomicBoolean();
    private volatile HttpURLConnection connection;
    private volatile long receivedBytes=0,totalBytes=0;
    private volatile String operationId="";
    private OrtSession session;
    private final Runnable release=()->worker.execute(this::closeSession);

    private File model(){return new File(new File(getContext().getFilesDir(),"style-model"),"vision.onnx");}
    private void closeSession(){if(session!=null){try{session.close();}catch(Exception ignored){}session=null;}}

    @PluginMethod public void modelStatus(PluginCall call){
        File file=model();JSObject result=new JSObject();
        result.put("present",file.isFile());result.put("bytes",file.isFile()?file.length():0);call.resolve(result);
    }

    @PluginMethod public void downloadModel(PluginCall call){
        String sha=call.getString("sha256","");
        try{ArtistPackDownload.initial(call.getString("url",""),"onnx");if(sha==null||!sha.matches("[a-f0-9]{64}"))throw new IOException("Invalid checksum");}
        catch(Exception error){call.reject("模型下载链接无效。",error);return;}
        if(!downloading.compareAndSet(false,true)){call.reject("模型正在下载。","BUSY");return;}
        operationId=call.getString("operationId","");cancelled.set(false);receivedBytes=0;totalBytes=0;
        worker.execute(()->{
            File target=model(),folder=target.getParentFile(),part=new File(folder,"vision.onnx.part");
            try{
                if(!folder.isDirectory()&&!folder.mkdirs())throw new IOException("无法创建模型目录");
                if(getContext().getFilesDir().getUsableSpace()<MAX_MODEL+64L*1024*1024)throw new IOException("手机可用空间不足，请先释放约 600 MB。");
                ArtistPackDownload.download(call.getString("url"),"onnx",MAX_MODEL,part,sha,url->(HttpURLConnection)url.openConnection(),
                    new ArtistPackDownload.Control(){
                        public boolean cancelled(){return cancelled.get();}
                        public void connection(HttpURLConnection current){connection=current;}
                    },(received,total)->{receivedBytes=received;totalBytes=total;});
                closeSession();
                if(target.exists()&&!target.delete())throw new IOException("无法替换旧模型");
                if(!part.renameTo(target))throw new IOException("无法保存模型");
                JSObject response=new JSObject();response.put("bytes",target.length());call.resolve(response);
            }catch(Exception error){
                if(part.exists())part.delete();
                if(cancelled.get()){JSObject response=new JSObject();response.put("cancelled",true);call.resolve(response);}
                else call.reject("模型下载失败："+error.getMessage(),error);
            }finally{connection=null;downloading.set(false);}
        });
    }
    @PluginMethod public void status(PluginCall call){
        JSObject result=new JSObject();result.put("busy",downloading.get());result.put("receivedBytes",receivedBytes);result.put("totalBytes",totalBytes);call.resolve(result);
    }
    @PluginMethod public void cancel(PluginCall call){
        if(downloading.get()&&operationId.equals(call.getString("operationId",""))){cancelled.set(true);HttpURLConnection current=connection;if(current!=null)current.disconnect();}
        call.resolve();
    }
    @PluginMethod public void deleteModel(PluginCall call){
        if(downloading.get()){call.reject("模型正在下载。","BUSY");return;}
        worker.execute(()->{
            closeSession();File file=model();
            if(file.exists()&&!file.delete()){call.reject("无法删除模型文件。");return;}
            call.resolve();
        });
    }

    private static float[] pixels(Bitmap source){
        float scale=(float)SIZE/Math.min(source.getWidth(),source.getHeight());
        int width=Math.max(SIZE,Math.round(source.getWidth()*scale)),height=Math.max(SIZE,Math.round(source.getHeight()*scale));
        Bitmap scaled=Bitmap.createScaledBitmap(source,width,height,true);
        Bitmap crop=Bitmap.createBitmap(scaled,(width-SIZE)/2,(height-SIZE)/2,SIZE,SIZE);
        int[] argb=new int[SIZE*SIZE];crop.getPixels(argb,0,SIZE,0,0,SIZE,SIZE);
        float[] data=new float[3*SIZE*SIZE];
        for(int i=0;i<SIZE*SIZE;i++){
            int p=argb[i];
            // Transparent pixels count as white, as the server's ImageMagick step flattens them.
            float a=((p>>>24)&255)/255f;
            float r=(((p>>16)&255)*a+255*(1-a))/255f,g=(((p>>8)&255)*a+255*(1-a))/255f,b=((p&255)*a+255*(1-a))/255f;
            data[i]=(r-MEAN[0])/STD[0];data[SIZE*SIZE+i]=(g-MEAN[1])/STD[1];data[2*SIZE*SIZE+i]=(b-MEAN[2])/STD[2];
        }
        if(crop!=scaled)crop.recycle();if(scaled!=source)scaled.recycle();
        return data;
    }
    private static Bitmap decode(byte[] bytes) throws IOException {
        BitmapFactory.Options bounds=new BitmapFactory.Options();bounds.inJustDecodeBounds=true;
        BitmapFactory.decodeByteArray(bytes,0,bytes.length,bounds);
        if(bounds.outWidth<=0||bounds.outHeight<=0)throw new IOException("无法读取这张图片，请换 JPG、PNG 或 WebP。");
        BitmapFactory.Options options=new BitmapFactory.Options();
        int sample=1;while(Math.min(bounds.outWidth,bounds.outHeight)/(sample*2)>=SIZE*2)sample*=2;
        options.inSampleSize=sample;options.inPreferredConfig=Bitmap.Config.ARGB_8888;
        Bitmap bitmap=BitmapFactory.decodeByteArray(bytes,0,bytes.length,options);
        if(bitmap==null)throw new IOException("无法读取这张图片，请换 JPG、PNG 或 WebP。");
        return bitmap;
    }

    // { data: base64 picture } → { vector: [768 raw CLIP image-embedding values] }
    @PluginMethod public void embed(PluginCall call){
        String data=call.getString("data","");
        if(data==null||data.isEmpty()||data.length()>32*1024*1024){call.reject("请选择一张图片。");return;}
        idle.removeCallbacks(release);
        worker.execute(()->{
            try{
                File file=model();if(!file.isFile())throw new IOException("还没有下载以图找画师的模型。");
                float[] input;
                {Bitmap bitmap=decode(Base64.decode(data,Base64.DEFAULT));input=pixels(bitmap);bitmap.recycle();}
                if(session==null){
                    OrtSession.SessionOptions options=new OrtSession.SessionOptions();
                    options.setIntraOpNumThreads(Math.max(1,Math.min(4,Runtime.getRuntime().availableProcessors())));options.setInterOpNumThreads(1);
                    options.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT);
                    options.setMemoryPatternOptimization(false);options.setCPUArenaAllocator(false);
                    options.addConfigEntry("session.disable_prepacking","1");
                    session=OrtEnvironment.getEnvironment().createSession(file.getPath(),options);
                }
                OrtEnvironment environment=OrtEnvironment.getEnvironment();
                try(OnnxTensor tensor=OnnxTensor.createTensor(environment,FloatBuffer.wrap(input),new long[]{1,3,SIZE,SIZE});
                    OrtSession.Result output=session.run(Collections.singletonMap("pixel_values",tensor))){
                    float[] vector=((float[][])output.get(0).getValue())[0];
                    JSArray values=new JSArray();for(float value:vector)values.put((double)value);
                    JSObject response=new JSObject();response.put("vector",values);call.resolve(response);
                }
            }catch(OutOfMemoryError error){closeSession();call.reject("手机内存不足，以图找画师无法运行。");}
            catch(Throwable error){call.reject(error instanceof IOException?error.getMessage():"以图找画师出错："+error.getMessage());}
            finally{idle.postDelayed(release,IDLE_MS);}
        });
    }

    @Override protected void handleOnDestroy(){
        cancelled.set(true);HttpURLConnection current=connection;if(current!=null)current.disconnect();
        idle.removeCallbacks(release);worker.execute(this::closeSession);worker.shutdown();super.handleOnDestroy();
    }
}
