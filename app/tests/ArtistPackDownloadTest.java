package app.naipocket.local;
import java.io.*;
import java.net.*;
import java.nio.file.*;
import java.util.*;

public class ArtistPackDownloadTest {
    static final String URL="https://github.com/example/resources/releases/download/v1/artists.zip";
    static final byte[] BYTES={1,2,3,4};
    static final String HASH="9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a";
    static class Response extends HttpURLConnection {
        final int status;final String location;final long length;boolean closed;
        Response(java.net.URL url,int status,String location,long length){super(url);this.status=status;this.location=location;this.length=length;}
        public void connect(){}public void disconnect(){closed=true;}public boolean usingProxy(){return false;}
        public int getResponseCode(){return status;}public String getHeaderField(String name){return name.equals("Location")?location:null;}
        public long getContentLengthLong(){return length;}public InputStream getInputStream(){return new ByteArrayInputStream(BYTES);}
    }
    static class Control implements ArtistPackDownload.Control {
        boolean cancelled;public boolean cancelled(){return cancelled;}public void connection(HttpURLConnection connection){}
    }
    interface Work {void run() throws Exception;}
    static void rejects(Work work) throws Exception {try{work.run();}catch(IOException expected){return;}throw new AssertionError("Expected rejection");}
    public static void main(String[] args) throws Exception {
        ArtistPackDownload.initial(URL);
        ArtistPackDownload.initial("https://github.com/example/resources/releases/latest/download/artists.zip");
        ArtistPackDownload.initial("https://github.com/example/resources/releases/download/feature%2Fv1/artists.zip");
        for(String bad:new String[]{"http://github.com/example/resources/releases/download/v1/artists.zip",URL+"?token=fixture",URL+"#fragment",URL.replace("github.com","github.com.evil.invalid"),URL.replace("github.com","user:pass@github.com"),URL.replace("github.com","127.0.0.1"),URL.replace("/releases/download/v1/","/raw/v1/"),URL.replace(".zip",".html")})rejects(()->ArtistPackDownload.initial(bad));
        File file=Files.createTempFile("nai-download-test-",".zip").toFile();List<Response> calls=new ArrayList<>();List<Long> progress=new ArrayList<>();
        try {
            ArtistPackDownload.download(URL,file,HASH,url->{Response response=new Response(url,calls.isEmpty()?302:200,calls.isEmpty()?"https://release-assets.githubusercontent.com/test/pack.zip?signature=fixture":null,4);calls.add(response);return response;},new Control(),(received,total)->progress.add(received));
            if(!Arrays.equals(Files.readAllBytes(file.toPath()),BYTES)||calls.size()!=2||!progress.contains(4L))throw new AssertionError("Download/redirect/progress mismatch");
            for(Response call:calls)if(!call.closed||call.getRequestProperty("Authorization")!=null||!"".equals(call.getRequestProperty("Cookie"))||call.getInstanceFollowRedirects())throw new AssertionError("Credential/redirect isolation");
            for(String redirect:new String[]{"http://release-assets.githubusercontent.com/p.zip","https://evil.invalid/p.zip","https://user:secret@release-assets.githubusercontent.com/p.zip"}) {
                final int[] count={0};rejects(()->ArtistPackDownload.download(URL,file,"",url->{count[0]++;return new Response(url,302,redirect,0);},new Control(),(a,b)->{}));
                if(count[0]!=1||file.exists())throw new AssertionError("Rejected redirect must not open another destination or keep a file");
            }
            rejects(()->ArtistPackDownload.download(URL,file,"0".repeat(64),url->new Response(url,200,null,4),new Control(),(a,b)->{}));
            if(file.exists())throw new AssertionError("Bad checksum retained");
            rejects(()->ArtistPackDownload.download(URL,file,"",url->new Response(url,200,null,8),new Control(),(a,b)->{}));
            if(file.exists())throw new AssertionError("Incomplete download retained");
            rejects(()->ArtistPackDownload.download(URL,file,"",url->new Response(url,200,null,ArtistPackArchive.MAX_TOTAL+1),new Control(),(a,b)->{}));
            Control control=new Control();rejects(()->ArtistPackDownload.download(URL,file,"",url->new Response(url,200,null,-1),control,(a,b)->{if(a>0)control.cancelled=true;}));
            if(file.exists())throw new AssertionError("Cancelled download retained");
            String catalogUrl=URL.replace("artists.zip","catalog.json");
            ArtistPackDownload.initial(catalogUrl,"json");
            rejects(()->ArtistPackDownload.initial(URL,"json"));
            calls.clear();
            String text=ArtistPackDownload.catalog(catalogUrl,url->{Response response=new Response(url,calls.isEmpty()?302:200,"https://release-assets.githubusercontent.com/test/catalog.json?signature=fixture",4);calls.add(response);return response;},new Control(),(a,b)->{});
            if(!text.equals(new String(BYTES,"UTF-8"))||calls.size()!=2)throw new AssertionError("Catalog redirect/read mismatch");
            for(Response call:calls)if(!call.closed||call.getRequestProperty("Authorization")!=null||!"".equals(call.getRequestProperty("Cookie")))throw new AssertionError("Catalog credential isolation");
            rejects(()->ArtistPackDownload.catalog(catalogUrl,url->new Response(url,200,null,ArtistPackDownload.MAX_CATALOG+1),new Control(),(a,b)->{}));
            rejects(()->ArtistPackDownload.catalog(catalogUrl,url->new Response(url,200,null,-1){public InputStream getInputStream(){return new ByteArrayInputStream(new byte[(int)ArtistPackDownload.MAX_CATALOG+1]);}},new Control(),(a,b)->{}));
            Control catalogControl=new Control();rejects(()->ArtistPackDownload.catalog(catalogUrl,url->new Response(url,200,null,4),catalogControl,(a,b)->{if(a>0)catalogControl.cancelled=true;}));
        } finally {Files.deleteIfExists(file.toPath());}
        System.out.println("Artist download passed: public HTTPS policy, redirect isolation, stream/progress, checksum, truncation, size admission and cancellation cleanup.");
    }
}
