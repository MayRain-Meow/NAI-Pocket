package app.naipocket.local;

import java.io.*;
import java.net.*;
import java.security.MessageDigest;
import java.util.Locale;

// Fixed public GitHub transport, independent of generation/account credentials.
final class ArtistPackDownload {
    interface Opener { HttpURLConnection open(URL url) throws IOException; }
    interface Control { boolean cancelled(); void connection(HttpURLConnection connection); }
    interface Progress { void update(long received,long total); }
    static URL initial(String value) throws Exception {
        return initial(value,"zip");
    }
    static URL initial(String value,String extension) throws Exception {
        if(value==null||value.length()>2048)throw new IOException("Invalid download URL");
        URI uri=new URI(value);URL url=uri.toURL();
        check(url,false);
        String path=uri.getPath();
        if(uri.getRawQuery()!=null||uri.getRawFragment()!=null||!uri.getRawPath().matches("/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/releases/(download/[^/]+/[^/]+|latest/download/[^/]+)")||!path.toLowerCase(Locale.ROOT).endsWith("."+extension))throw new IOException("Use a GitHub Release asset download URL");
        for(String part:path.split("/"))if(part.equals(".")||part.equals(".."))throw new IOException("Invalid download path");
        return url;
    }
    private static void check(URL url,boolean redirect) throws IOException {
        String host=url.getHost().toLowerCase(Locale.ROOT);
        if(!url.getProtocol().equals("https")||url.getUserInfo()!=null||(url.getPort()!=-1&&url.getPort()!=443)
            ||!(host.equals("github.com")||(redirect&&host.equals("release-assets.githubusercontent.com"))))throw new IOException("Untrusted download destination");
    }
    private static void checkCancelled(Control control) throws InterruptedIOException {
        if(control.cancelled()||Thread.currentThread().isInterrupted())throw new InterruptedIOException("Cancelled");
    }
    static void download(String value,File target,String expectedHash,Opener opener,Control control,Progress progress) throws Exception {
        download(value,"zip",ArtistPackArchive.MAX_TOTAL,target,expectedHash,opener,control,progress);
    }
    static void download(String value,String extension,long limit,File target,String expectedHash,Opener opener,Control control,Progress progress) throws Exception {
        URL url=initial(value,extension);
        if(expectedHash!=null&&!expectedHash.isEmpty()&&!expectedHash.matches("[a-f0-9]{64}"))throw new IOException("Invalid archive checksum");
        try(FileOutputStream output=new FileOutputStream(target)) {
            receive(url,output,limit,expectedHash,opener,control,progress);
            output.getFD().sync();
        } catch(Exception error) {if(target.exists()&&!target.delete())target.deleteOnExit();throw error;}
    }
    static final long MAX_CATALOG=2L*1024*1024;
    static String catalog(String value,Opener opener,Control control,Progress progress) throws Exception {
        ByteArrayOutputStream output=new ByteArrayOutputStream();
        receive(initial(value,"json"),output,MAX_CATALOG,"",opener,control,progress);
        return output.toString("UTF-8");
    }
    private static void receive(URL url,OutputStream output,long limit,String expectedHash,Opener opener,Control control,Progress progress) throws Exception {
            for(int redirects=0;redirects<=3;redirects++) {
                checkCancelled(control);check(url,redirects>0);
                HttpURLConnection connection=opener.open(url);control.connection(connection);
                try {
                    connection.setInstanceFollowRedirects(false);connection.setConnectTimeout(20000);connection.setReadTimeout(30000);
                    connection.setRequestMethod("GET");connection.setRequestProperty("Accept","application/octet-stream");
                    connection.setRequestProperty("Accept-Encoding","identity");connection.setRequestProperty("User-Agent","NAI-Pocket/artist-resources");
                    // Never attach Tokens or a WebView cookie jar to public resources.
                    connection.setRequestProperty("Cookie","");
                    checkCancelled(control);int status=connection.getResponseCode();
                    if(status==301||status==302||status==303||status==307||status==308) {
                        String location=connection.getHeaderField("Location");if(location==null)throw new IOException("Missing download redirect");
                        url=new URL(url,location);check(url,true);continue;
                    }
                    if(status!=200)throw new IOException("Download HTTP "+status);
                    long total=connection.getContentLengthLong(),received=0;
                    if(total>limit)throw new IOException("Resource too large");
                    MessageDigest digest=MessageDigest.getInstance("SHA-256");
                    progress.update(0,Math.max(0,total));
                    try(InputStream input=connection.getInputStream()) {
                        byte[] buffer=new byte[65536];int count;
                        while((count=input.read(buffer))!=-1) {
                            checkCancelled(control);received+=count;
                            if(received>limit)throw new IOException("Resource too large");
                            output.write(buffer,0,count);digest.update(buffer,0,count);progress.update(received,Math.max(0,total));
                        }
                    }
                    checkCancelled(control);
                    if(total>=0&&received!=total)throw new IOException("Incomplete download");
                    StringBuilder hash=new StringBuilder();for(byte b:digest.digest())hash.append(String.format(Locale.ROOT,"%02x",b&255));
                    if(expectedHash!=null&&!expectedHash.isEmpty()&&!expectedHash.equals(hash.toString()))throw new IOException("Archive checksum mismatch");
                    return;
                } finally {control.connection(null);connection.disconnect();}
            }
            throw new IOException("Too many download redirects");
    }
}
