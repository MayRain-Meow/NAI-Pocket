package app.naipocket.local;

import android.app.ActivityManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.os.Build;
import android.webkit.WebView;
import com.getcapacitor.JSObject;
import java.io.PrintWriter;
import java.io.StringWriter;

// Start-up record that survives a crash (0.7.7). Each start step is committed to disk before the step
// runs, so the next start knows where the last one stopped; a Java crash or a dead WebView renderer leaves
// a short note. The app reads it all once at the next start: an unfinished start opens in safe mode and
// offers the diagnostics to copy. Nothing leaves the phone unless the user copies it.
final class BootRecord {
    private static final String PREFS = "nai-pocket-boot";
    private BootRecord() {}
    private static SharedPreferences prefs(Context context) { return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE); }

    // Starting: hand back the previous start and any crash note, then mark this start as running.
    static JSObject begin(Context context, String version) {
        SharedPreferences p = prefs(context);
        JSObject result = new JSObject();
        boolean known = p.contains("startedAt"), done = p.getBoolean("done", true);
        int failures = known && !done ? p.getInt("failures", 0) + 1 : 0;
        if (known) {
            JSObject previous = new JSObject();
            previous.put("step", p.getString("step", ""));
            previous.put("startedAt", p.getLong("startedAt", 0));
            previous.put("version", p.getString("version", ""));
            previous.put("done", done);
            result.put("previous", previous);
        }
        if (p.contains("crashAt")) {
            JSObject crash = new JSObject();
            crash.put("type", p.getString("crashType", ""));
            crash.put("detail", p.getString("crashDetail", ""));
            crash.put("at", p.getLong("crashAt", 0));
            result.put("crash", crash);
        }
        result.put("failures", failures);
        result.put("device", device(context));
        p.edit().putString("step", "启动").putLong("startedAt", System.currentTimeMillis()).putString("version", version)
            .putBoolean("done", false).putInt("failures", failures).commit();
        return result;
    }

    static void mark(Context context, String step) { prefs(context).edit().putString("step", step).commit(); }

    // The editor is on screen: this start counts as finished and the crash note has been read.
    static void done(Context context) {
        prefs(context).edit().putBoolean("done", true).putInt("failures", 0)
            .remove("crashType").remove("crashDetail").remove("crashAt").commit();
    }

    static void crash(Context context, String type, String detail) {
        prefs(context).edit().putString("crashType", type).putString("crashDetail", detail.length() > 4000 ? detail.substring(0, 4000) : detail)
            .putLong("crashAt", System.currentTimeMillis()).commit();
    }

    static void nativeCrash(Context context, Thread thread, Throwable error) {
        StringWriter text = new StringWriter();
        error.printStackTrace(new PrintWriter(text));
        crash(context, "native", "thread " + thread.getName() + "\n" + text);
    }

    private static JSObject device(Context context) {
        JSObject device = new JSObject();
        device.put("manufacturer", Build.MANUFACTURER);
        device.put("model", Build.MODEL);
        device.put("android", Build.VERSION.RELEASE);
        device.put("sdk", Build.VERSION.SDK_INT);
        try {
            ActivityManager manager = (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
            ActivityManager.MemoryInfo memory = new ActivityManager.MemoryInfo();
            manager.getMemoryInfo(memory);
            device.put("totalMemory", memory.totalMem);
            device.put("availableMemory", memory.availMem);
            device.put("lowMemory", memory.lowMemory);
            device.put("memoryClass", manager.getMemoryClass());
            device.put("largeMemoryClass", manager.getLargeMemoryClass());
        } catch (Exception ignored) {}
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                PackageInfo webView = WebView.getCurrentWebViewPackage();
                if (webView != null) device.put("webView", webView.packageName + " " + webView.versionName);
            }
        } catch (Exception ignored) {}
        return device;
    }
}
