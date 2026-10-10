package app.naipocket.local;

import java.io.File;
import java.io.IOException;
import java.nio.file.*;
import java.util.*;

public class ArtistPackMaintenanceTest {
    static void check(boolean value,String message) {if(!value)throw new AssertionError(message);}
    static File folder(File root,String name) throws Exception {File file=new File(root,name);Files.createDirectory(file.toPath());return file;}
    static File image(File root,String name) throws Exception {File file=new File(root,name);Files.write(file.toPath(),new byte[]{1,2,3});return file;}
    static ArtistPackMaintenance.Result clean(File resources,File cache,Set<String> keep) throws Exception {
        return ArtistPackMaintenance.clean(resources,cache,keep,file->Files.isSymbolicLink(file.toPath()));
    }
    public static void main(String[] args) throws Exception {
        File root=Files.createTempDirectory("nai-pack-maintenance-test-").toFile().getCanonicalFile();
        File resources=folder(root,"artist-resources"),cache=folder(root,"cache");
        String active=UUID.randomUUID().toString(),old=UUID.randomUUID().toString(),staged=UUID.randomUUID().toString();
        File activeFile=image(folder(resources,active),"same-preview.webp"),oldDir=folder(resources,old),stageDir=folder(resources,staged);
        image(oldDir,"same-preview.webp");image(stageDir,"partial-thumb.png");
        File empty=folder(resources,UUID.randomUUID().toString());
        File legacy=image(folder(resources,"legacy-set"),"old-preview.jpg");
        File unknown=image(folder(resources,"other-data"),"note.txt");
        File unexpected=folder(resources,UUID.randomUUID().toString());
        File preserved=image(unexpected,"valid-thumb.png");image(unexpected,"note.txt");
        File nested=folder(resources,UUID.randomUUID().toString());image(folder(nested,"nested"),"private-preview.png");
        File archive=image(cache,"nai-artist-123456.zip"),unrelated=image(cache,"other-download.zip");
        File outside=image(root,"outside-preview.png");boolean symlinks=false;
        File linked=folder(resources,UUID.randomUUID().toString());
        try {Files.createSymbolicLink(new File(linked,"linked-preview.png").toPath(),outside.toPath());symlinks=true;}
        catch(IOException|UnsupportedOperationException|SecurityException unavailable) {Files.delete(linked.toPath());}
        try {
            clean(resources,cache,new HashSet<>(Arrays.asList(active,"../outside")));
            throw new AssertionError("Invalid keep set should reject before deletion");
        } catch(IOException expected) {check(oldDir.exists()&&archive.exists(),"Invalid database authority must not delete anything");}
        ArtistPackMaintenance.Result result=clean(resources,cache,new HashSet<>(Arrays.asList(active,"legacy-set")));
        check(activeFile.exists()&&legacy.exists(),"Committed and legacy data must remain");
        check(!oldDir.exists()&&!stageDir.exists()&&!empty.exists()&&!archive.exists(),"Old, interrupted and download files should be reclaimed");
        check(unknown.exists()&&preserved.exists()&&nested.exists()&&unrelated.exists()&&outside.exists(),"Unrecognized files and roots must remain untouched");
        if(symlinks)check(linked.exists(),"Do not follow or remove linked directories");
        check(result.directories==3&&result.files==3&&result.bytes==9,"Report only files actually removed");
        // Power/process loss after commit: a fresh sweep still preserves active bytes.
        ArtistPackMaintenance.Result again=clean(resources,cache,Set.of(active,"legacy-set"));
        check(again.files==0&&activeFile.exists(),"Recovery must be idempotent");
        System.out.println("Artist maintenance passed: committed/legacy protection, interrupted-stage/cache recovery, strict flat-path admission and idempotence. Symlink check: "+(symlinks?"passed":"unavailable on this host"));
        System.out.println("Maintenance fixture retained: "+root);
    }
}
