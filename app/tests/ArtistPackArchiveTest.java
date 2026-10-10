package app.naipocket.local;
import java.io.*;
import java.nio.file.*;
import java.util.zip.*;

public class ArtistPackArchiveTest {
    static byte[] archive(String name,byte[] bytes,boolean manifest) throws Exception {
        ByteArrayOutputStream output=new ByteArrayOutputStream();
        try(ZipOutputStream zip=new ZipOutputStream(output)) {
            if(manifest){zip.putNextEntry(new ZipEntry("manifest.json"));zip.write("{}".getBytes());zip.closeEntry();}
            zip.putNextEntry(new ZipEntry(name));zip.write(bytes);zip.closeEntry();
        }
        return output.toByteArray();
    }
    static ArtistPackArchive.Result unpack(byte[] bytes) throws Exception {
        File folder=Files.createTempDirectory("nai-pack-archive-test-").toFile();
        try{return ArtistPackArchive.extract(new ByteArrayInputStream(bytes),folder,file->new ArtistPackArchive.ImageInfo("image/png",2,2));}
        finally{for(File file:folder.listFiles())Files.delete(file.toPath());Files.delete(folder.toPath());}
    }
    static void rejects(byte[] bytes) throws Exception {try{unpack(bytes);}catch(IOException expected){return;}throw new AssertionError("Archive should fail");}
    public static void main(String[] args) throws Exception {
        if(args.length>0) {
            for(String filename:args) {
                File folder=Files.createTempDirectory("nai-producer-zip-check-").toFile();
                ArtistPackArchive.Result pack;
                try(InputStream input=new FileInputStream(filename)) {
                    pack=ArtistPackArchive.extract(input,folder,file->new ArtistPackArchive.ImageInfo(file.getName().endsWith(".webp")?"image/webp":file.getName().endsWith(".jpg")?"image/jpeg":"image/png",2,2));
                }
                if(!pack.manifest.contains("nai-pocket-artist-pack"))throw new AssertionError("Missing producer manifest");
                System.out.println("Producer ZIP accepted by native archive reader: "+new File(filename).getName()+"; image files="+pack.files.size());
            }
            return;
        }
        byte[] image=new byte[]{1,2,3,4};
        ArtistPackArchive.Result result=unpack(archive("image-thumb.png",image,true));
        if(result.files.size()!=1||result.files.get(0).bytes!=4||!result.files.get(0).sha256.equals("9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a"))throw new AssertionError("Stream digest or metadata mismatch");
        for(String name:new String[]{"../image-thumb.png","/image-thumb.png","nested/image-thumb.png","vault.json","image-thumb.svg"})rejects(archive(name,image,true));
        rejects(archive("image-thumb.png",image,false));
        rejects(archive("image-thumb.png",new byte[ArtistPackArchive.MAX_IMAGE+1],true));
        System.out.println("Artist archive passed: streaming digest, traversal/extra-file rejection, missing manifest and decompression bound.");
    }
}
