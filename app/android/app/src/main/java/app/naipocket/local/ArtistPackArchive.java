package app.naipocket.local;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.function.BooleanSupplier;
import java.util.function.LongConsumer;

// Pure streaming archive reader. No image or archive crosses the JS bridge as Base64.
final class ArtistPackArchive {
    static final long MAX_TOTAL = 256L * 1024 * 1024;
    static final int MAX_MANIFEST = 8 * 1024 * 1024;
    static final int MAX_IMAGE = 4 * 1024 * 1024;
    static final int MAX_FILES = 16000;
    interface Inspector { ImageInfo inspect(File file) throws Exception; }
    static final class ImageInfo {
        final String mime; final int width, height;
        ImageInfo(String mime, int width, int height) { this.mime=mime; this.width=width; this.height=height; }
    }
    static final class Entry {
        final String name, sha256; final long bytes; final ImageInfo image;
        Entry(String name, String sha256, long bytes, ImageInfo image) { this.name=name; this.sha256=sha256; this.bytes=bytes; this.image=image; }
    }
    static final class Result {
        String manifest; final List<Entry> files = new ArrayList<>();
    }
    private static final class Limited extends FilterInputStream {
        long count;
        Limited(InputStream input) { super(input); }
        private void add(int size) throws IOException { if(size>0 && (count+=size)>MAX_TOTAL)throw new IOException("Archive too large"); }
        @Override public int read() throws IOException { int value=in.read();add(value<0?0:1);return value; }
        @Override public int read(byte[] bytes,int offset,int length) throws IOException {int size=in.read(bytes,offset,length);add(size);return size;}
    }
    static Result extract(InputStream source, File directory, Inspector inspector) throws Exception {
        return extract(source,directory,inspector,()->false,bytes->{});
    }
    static Result extract(InputStream source, File directory, Inspector inspector, BooleanSupplier cancelled, LongConsumer progress) throws Exception {
        if(!directory.isDirectory())throw new IOException("No staging directory");
        Result result=new Result(); Set<String> names=new HashSet<>(); long total=0;
        try(ZipInputStream zip=new ZipInputStream(new Limited(source))) {
            ZipEntry entry; byte[] buffer=new byte[65536];
            while((entry=zip.getNextEntry())!=null) {
                if(cancelled.getAsBoolean()||Thread.currentThread().isInterrupted())throw new InterruptedIOException();
                String name=entry.getName(); boolean manifest=name.equals("manifest.json");
                if(entry.isDirectory() || (!manifest && !name.matches("[a-zA-Z0-9_-]{1,100}-(thumb|preview)\\.(png|jpg|webp)")) || !names.add(name))throw new IOException("Invalid or duplicate archive entry");
                if(names.size()>MAX_FILES+1)throw new IOException("Too many archive entries");
                int limit=manifest?MAX_MANIFEST:MAX_IMAGE; long size=0;
                File output=new File(directory,name).getCanonicalFile();
                if(!output.getParentFile().equals(directory.getCanonicalFile()))throw new IOException("Invalid entry path");
                MessageDigest digest=MessageDigest.getInstance("SHA-256");
                ByteArrayOutputStream text=manifest?new ByteArrayOutputStream():null;
                try(OutputStream target=manifest?text:new FileOutputStream(output)) {
                    int read;
                    while((read=zip.read(buffer))!=-1) {
                        if(cancelled.getAsBoolean()||Thread.currentThread().isInterrupted())throw new InterruptedIOException();
                        size+=read;total+=read;
                        if(size>limit||total>MAX_TOTAL)throw new IOException("Archive exceeds extraction limit");
                        target.write(buffer,0,read);digest.update(buffer,0,read);progress.accept(total);
                    }
                }
                zip.closeEntry();
                if(manifest)result.manifest=StandardCharsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(text.toByteArray())).toString();
                else {
                    ImageInfo image=inspector.inspect(output);
                    if(image==null || image.mime==null || !image.mime.matches("image/(png|jpeg|webp)") || image.width<1 || image.height<1
                        || image.width>10000 || image.height>10000 || (long)image.width*image.height>32000000)throw new IOException("Invalid image");
                    StringBuilder hash=new StringBuilder();for(byte value:digest.digest())hash.append(String.format(java.util.Locale.ROOT,"%02x",value&255));
                    result.files.add(new Entry(name,hash.toString(),size,image));
                }
            }
        }
        if(result.manifest==null)throw new IOException("Missing manifest.json");
        return result;
    }
}
