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
    public PocketMediaClient(Bridge bridge) { super(bridge); }
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
