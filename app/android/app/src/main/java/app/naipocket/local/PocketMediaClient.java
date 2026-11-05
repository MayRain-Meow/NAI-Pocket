package app.naipocket.local;

import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.util.Collections;
import java.util.concurrent.ConcurrentHashMap;

// Routes are registered from SQLite by the app. No arbitrary filesystem URL is accepted.
public class PocketMediaClient extends BridgeWebViewClient {
    static final ConcurrentHashMap<String, Entry> media = new ConcurrentHashMap<>();
    static final class Entry {
        final File file; final String mime;
        Entry(File file, String mime) { this.file = file; this.mime = mime; }
    }
    private final Bridge bridge;
    public PocketMediaClient(Bridge bridge) { super(bridge); this.bridge = bridge; }
    // The WebView's renderer died (most often out of memory). Left alone, Android closes the whole app —
    // the "闪退" users saw. Instead: leave a note, drop the dead WebView and rebuild the screen; the next
    // start sees the unfinished start and opens in safe mode.
    @Override public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
        android.app.Activity activity = bridge.getActivity();
        try { BootRecord.crash(view.getContext(), "renderer", "didCrash=" + detail.didCrash() + " priorityAtExit=" + detail.rendererPriorityAtExit()); } catch (Throwable ignored) {}
        try { if (view.getParent() instanceof android.view.ViewGroup) ((android.view.ViewGroup) view.getParent()).removeView(view); view.destroy(); } catch (Throwable ignored) {}
        if (activity != null && !activity.isFinishing()) {
            try { activity.recreate(); }
            catch (Throwable error) {
                android.content.Intent restart = activity.getPackageManager().getLaunchIntentForPackage(activity.getPackageName());
                if (restart != null) { restart.addFlags(android.content.Intent.FLAG_ACTIVITY_CLEAR_TASK | android.content.Intent.FLAG_ACTIVITY_NEW_TASK); activity.startActivity(restart); }
                activity.finish();
            }
        }
        return true;
    }
    @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        if ("https".equals(request.getUrl().getScheme()) && "localhost".equals(request.getUrl().getHost()) && request.getUrl().getPath().startsWith("/api/")) {
            Entry entry = media.get(request.getUrl().getPath());
            try {
                if (entry != null && (request.getMethod().equals("GET") || request.getMethod().equals("HEAD"))) {
                    return new WebResourceResponse(entry.mime, null, 200, "OK", Collections.singletonMap("Cache-Control", "no-store"),
                        request.getMethod().equals("HEAD") ? new ByteArrayInputStream(new byte[0]) : new FileInputStream(entry.file));
                }
            } catch (Exception ignored) {}
            return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", Collections.singletonMap("Cache-Control", "no-store"), new ByteArrayInputStream(new byte[0]));
        }
        return super.shouldInterceptRequest(view, request);
    }
}
