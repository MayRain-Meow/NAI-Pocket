package app.naipocket.local;

import java.io.File;
import java.io.IOException;
import java.io.InterruptedIOException;
import java.util.HashSet;
import java.util.Set;

// Startup only, before readers/imports: the committed database owns the keep set.
final class ArtistPackMaintenance {
    interface LinkCheck { boolean isLink(File file) throws IOException; }
    static final class Result {
        int directories,files,skipped;
        long bytes;
    }
    static Set<String> keepSet(Iterable<String> directories) throws IOException {
        if(directories==null)throw new IOException("Missing active resource directories");
        Set<String> keep=new HashSet<>();
        for(String name:directories) {
            if(name==null||!name.matches("[A-Za-z0-9_-]{1,100}"))throw new IOException("Invalid active resource directory");
            keep.add(name);
        }
        return keep;
    }
    private static File[] entries(File root) throws IOException {
        if(!root.exists())return new File[0];
        File[] files=root.listFiles();
        if(files==null)throw new IOException("Cannot inspect resource directory");
        return files;
    }
    private static boolean direct(File file,File parent,LinkCheck links) throws IOException {
        // Refuse symlinks, even when their target remains within the same root.
        return !links.isLink(file)&&file.getAbsoluteFile().equals(file.getCanonicalFile())&&file.getCanonicalFile().getParentFile().equals(parent);
    }
    private static void interrupted() throws InterruptedIOException {
        if(Thread.currentThread().isInterrupted())throw new InterruptedIOException("Resource cleanup interrupted");
    }
    private static void remove(File file,Result result) throws IOException {
        interrupted();long bytes=file.length();
        if(file.delete()){result.files++;result.bytes+=bytes;}else result.skipped++;
    }
    static Result clean(File resources,File cache,Set<String> active,LinkCheck links) throws IOException {
        Set<String> keep=keepSet(active); // Validate all authority before any deletion.
        File root=resources.getCanonicalFile(),cacheRoot=cache.getCanonicalFile();
        // Do not follow a replaced resource-root symlink outside app files.
        if(links.isLink(resources)||links.isLink(cache)||!resources.getAbsoluteFile().equals(root)||!cache.getAbsoluteFile().equals(cacheRoot))throw new IOException("Unexpected resource root");
        Result result=new Result();
        for(File folder:entries(root)) {
            interrupted();String name=folder.getName();
            if(keep.contains(name))continue;
            if(!name.matches("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")||!direct(folder,root,links)||!folder.isDirectory()) {result.skipped++;continue;}
            File[] children=entries(folder);boolean safe=true;
            // Inspect the entire flat directory before removing any of its files.
            for(File file:children)if(!direct(file,folder,links)||!file.isFile()||!file.getName().matches("[A-Za-z0-9_-]{1,100}-(thumb|preview)\\.(png|jpg|webp)")){safe=false;break;}
            if(!safe){result.skipped++;continue;}
            for(File file:children)remove(file,result);
            if(folder.delete())result.directories++;else result.skipped++;
        }
        for(File file:entries(cacheRoot)) {
            interrupted();
            if(!file.getName().matches("nai-artist-[0-9]+\\.zip"))continue;
            if(!direct(file,cacheRoot,links)||!file.isFile()){result.skipped++;continue;}
            remove(file,result);
        }
        return result;
    }
}
