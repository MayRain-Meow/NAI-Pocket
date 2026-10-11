package app.naipocket.local;

import java.io.*;
import java.net.*;
import java.security.MessageDigest;
import java.util.Locale;

// App update transport: only this project's GitHub Release APK (and its .sha256), followed
// through GitHub's asset redirects. Same approach as ArtistPackDownload (fixed hosts, manual
// redirects, no credentials or cookies), kept separate so the pack downloader stays unchanged.
// The signature/versionCode check before installing is in AppUpdatePlugin.
final class AppUpdateDownload {
    static final long MAX_APK=80L*1024*1024,MAX_CHECKSUM=4096;
    private static final String RELEASE_PATH="/MayRain-Meow/NAI-Pocket/releases/download/v([0-9]+\\.[0-9]+\\.[0-9]+)(?:-preview)?/NAI-Pocket-v\\1-preview\\.apk";
    static URL initial(String value,boolean checksum) throws Exception {
        if(value==null||value.length()>2048)throw new IOException("Invalid update URL");
        URI uri=new URI(value);URL url=uri.toURL();
        check(url,false);
        if(uri.getRawQuery()!=null||uri.getRawFragment()!=null||uri.getRawPath()==null||!uri.getRawPath().matches(RELEASE_PATH+(checksum?"\\.sha256":"")))throw new IOException("Not a NAI Pocket release asset");
        return url;
    }
    private static void check(URL url,boolean redirect) throws IOException {
        String host=url.getHost().toLowerCase(Locale.ROOT);
        if(!url.getProtocol().equals("https")||url.getUserInfo()!=null||(url.getPort()!=-1&&url.getPort()!=443)
            ||!(host.equals("github.com")||(redirect&&(host.equals("release-assets.githubusercontent.com")||host.equals("objects.githubusercontent.com")))))
            throw new IOException("Untrusted update destination");
    }
    private static void checkCancelled(ArtistPackDownload.Control control) throws InterruptedIOException {
        if(control.cancelled()||Thread.currentThread().isInterrupted())throw new InterruptedIOException("Cancelled");
    }
    // Returns the SHA-256 of the written file; the file is removed on any failure.
    static String download(String value,File target,String expectedHash,ArtistPackDownload.Opener opener,ArtistPackDownload.Control control,ArtistPackDownload.Progress progress) throws Exception {
        URL url=initial(value,false);
        if(expectedHash!=null&&!expectedHash.isEmpty()&&!expectedHash.matches("[a-f0-9]{64}"))throw new IOException("Invalid update checksum");
        try(FileOutputStream output=new FileOutputStream(target)) {
            String hash=receive(url,output,MAX_APK,opener,control,progress);
            output.getFD().sync();
            if(expectedHash!=null&&!expectedHash.isEmpty()&&!expectedHash.equals(hash))throw new IOException("Update checksum mismatch");
            return hash;
        } catch(Exception error) {if(target.exists()&&!target.delete())target.deleteOnExit();throw error;}
    }
    // `sha256sum` style text: the first token must be 64 hex digits.
    static String checksum(String value,ArtistPackDownload.Opener opener,ArtistPackDownload.Control control) throws Exception {
        ByteArrayOutputStream output=new ByteArrayOutputStream();
        receive(initial(value,true),output,MAX_CHECKSUM,opener,control,(a,b)->{});
        String text=output.toString("UTF-8").trim();
        String first=text.isEmpty()?"":text.split("\\s+")[0].toLowerCase(Locale.ROOT);
        if(!first.matches("[a-f0-9]{64}"))throw new IOException("Invalid update checksum file");
        return first;
    }
    private static String receive(URL url,OutputStream output,long limit,ArtistPackDownload.Opener opener,ArtistPackDownload.Control control,ArtistPackDownload.Progress progress) throws Exception {
        for(int redirects=0;redirects<=5;redirects++) {
            checkCancelled(control);check(url,redirects>0);
            HttpURLConnection connection=opener.open(url);control.connection(connection);
            try {
                connection.setInstanceFollowRedirects(false);connection.setConnectTimeout(20000);connection.setReadTimeout(30000);
                connection.setRequestMethod("GET");connection.setRequestProperty("Accept","application/octet-stream");
                connection.setRequestProperty("Accept-Encoding","identity");connection.setRequestProperty("User-Agent","NAI-Pocket/app-update");
                // Never attach Tokens or a WebView cookie jar to public downloads.
                connection.setRequestProperty("Cookie","");
                checkCancelled(control);int status=connection.getResponseCode();
                if(status==301||status==302||status==303||status==307||status==308) {
                    String location=connection.getHeaderField("Location");if(location==null)throw new IOException("Missing update redirect");
                    url=new URL(url,location);check(url,true);continue;
                }
                if(status!=200)throw new IOException("Update HTTP "+status);
                long total=connection.getContentLengthLong(),received=0;
                if(total>limit)throw new IOException("Update too large");
                MessageDigest digest=MessageDigest.getInstance("SHA-256");
                progress.update(0,Math.max(0,total));
                try(InputStream input=connection.getInputStream()) {
                    byte[] buffer=new byte[65536];int count;
                    while((count=input.read(buffer))!=-1) {
                        checkCancelled(control);received+=count;
                        if(received>limit)throw new IOException("Update too large");
                        output.write(buffer,0,count);digest.update(buffer,0,count);progress.update(received,Math.max(0,total));
                    }
                }
                checkCancelled(control);
                if(total>=0&&received!=total)throw new IOException("Incomplete update download");
                StringBuilder hash=new StringBuilder();for(byte b:digest.digest())hash.append(String.format(Locale.ROOT,"%02x",b&255));
                return hash.toString();
            } finally {control.connection(null);connection.disconnect();}
        }
        throw new IOException("Too many update redirects");
    }
}
