package app.naipocket.local;
import java.io.*;
import java.net.*;
import java.nio.file.*;
import java.util.*;

public class AppUpdateDownloadTest {
    static final String URL="https://github.com/MayRain-Meow/NAI-Pocket/releases/download/v0.3.5-preview/NAI-Pocket-v0.3.5-preview.apk";
    static final byte[] BYTES={1,2,3,4};
    static final String HASH="9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a";
    static class Response extends HttpURLConnection {
        final int status;final String location;final long length;final byte[] body;boolean closed;
        Response(java.net.URL url,int status,String location,long length,byte[] body){super(url);this.status=status;this.location=location;this.length=length;this.body=body;}
        Response(java.net.URL url,int status,String location,long length){this(url,status,location,length,BYTES);}
        public void connect(){}public void disconnect(){closed=true;}public boolean usingProxy(){return false;}
        public int getResponseCode(){return status;}public String getHeaderField(String name){return name.equals("Location")?location:null;}
        public long getContentLengthLong(){return length;}public InputStream getInputStream(){return new ByteArrayInputStream(body);}
    }
    static class Control implements ArtistPackDownload.Control {
        boolean cancelled;public boolean cancelled(){return cancelled;}public void connection(HttpURLConnection connection){}
    }
    interface Work {void run() throws Exception;}
    static void rejects(Work work) throws Exception {try{work.run();}catch(IOException expected){return;}throw new AssertionError("Expected rejection");}
    public static void main(String[] args) throws Exception {
        AppUpdateDownload.initial(URL,false);
        AppUpdateDownload.initial(URL.replace("v0.3.5-preview/","v0.3.5/"),false);
        AppUpdateDownload.initial(URL+".sha256",true);
        for(String bad:new String[]{URL.replace("https:","http:"),URL+"?x=1",URL+"#f",URL.replace("github.com","github.com.evil.invalid"),URL.replace("github.com","user:pass@github.com"),
            URL.replace("MayRain-Meow/NAI-Pocket","someone/NAI-Pocket"),URL.replace("NAI-Pocket-v0.3.5","NAI-Pocket-v0.3.6"),URL.replace(".apk",".zip"),URL+".sha256",
            "https://release-assets.githubusercontent.com/x/NAI-Pocket-v0.3.5-preview.apk"})rejects(()->AppUpdateDownload.initial(bad,false));
        rejects(()->AppUpdateDownload.initial(URL,true));
        File file=Files.createTempFile("nai-update-test-",".apk").toFile();List<Response> calls=new ArrayList<>();List<Long> progress=new ArrayList<>();
        try {
            for(String host:new String[]{"release-assets.githubusercontent.com","objects.githubusercontent.com"}) {
                calls.clear();
                String hash=AppUpdateDownload.download(URL,file,HASH,url->{Response response=new Response(url,calls.isEmpty()?302:200,calls.isEmpty()?"https://"+host+"/x/app.apk?sig=fixture":null,4);calls.add(response);return response;},new Control(),(received,total)->progress.add(received));
                if(!hash.equals(HASH)||!Arrays.equals(Files.readAllBytes(file.toPath()),BYTES)||calls.size()!=2||!progress.contains(4L))throw new AssertionError("Download/redirect/progress mismatch via "+host);
                for(Response call:calls)if(!call.closed||call.getRequestProperty("Authorization")!=null||!"".equals(call.getRequestProperty("Cookie"))||call.getInstanceFollowRedirects())throw new AssertionError("Credential/redirect isolation");
            }
            for(String redirect:new String[]{"http://release-assets.githubusercontent.com/p.apk","https://evil.invalid/p.apk","https://user:secret@objects.githubusercontent.com/p.apk"}) {
                final int[] count={0};rejects(()->AppUpdateDownload.download(URL,file,"",url->{count[0]++;return new Response(url,302,redirect,0);},new Control(),(a,b)->{}));
                if(count[0]!=1||file.exists())throw new AssertionError("Rejected redirect must not open another destination or keep a file");
            }
            rejects(()->AppUpdateDownload.download(URL,file,"0".repeat(64),url->new Response(url,200,null,4),new Control(),(a,b)->{}));
            if(file.exists())throw new AssertionError("Bad checksum retained");
            rejects(()->AppUpdateDownload.download(URL,file,"",url->new Response(url,200,null,8),new Control(),(a,b)->{}));
            if(file.exists())throw new AssertionError("Incomplete download retained");
            rejects(()->AppUpdateDownload.download(URL,file,"",url->new Response(url,200,null,AppUpdateDownload.MAX_APK+1),new Control(),(a,b)->{}));
            Control control=new Control();rejects(()->AppUpdateDownload.download(URL,file,"",url->new Response(url,200,null,-1),control,(a,b)->{if(a>0)control.cancelled=true;}));
            if(file.exists())throw new AssertionError("Cancelled download retained");
            byte[] text=(HASH.toUpperCase(Locale.ROOT)+"  NAI-Pocket-v0.3.5-preview.apk\n").getBytes("UTF-8");
            String checksum=AppUpdateDownload.checksum(URL+".sha256",url->new Response(url,200,null,text.length,text),new Control());
            if(!checksum.equals(HASH))throw new AssertionError("Checksum file parse");
            rejects(()->AppUpdateDownload.checksum(URL+".sha256",url->new Response(url,200,null,3,"bad".getBytes("UTF-8")),new Control()));
            rejects(()->AppUpdateDownload.checksum(URL+".sha256",url->new Response(url,200,null,AppUpdateDownload.MAX_CHECKSUM+1),new Control()));
        } finally {Files.deleteIfExists(file.toPath());}
        System.out.println("App update download passed: repository/asset URL policy, GitHub redirect hosts, credential isolation, checksum, truncation, size cap and cancellation cleanup.");
    }
}
