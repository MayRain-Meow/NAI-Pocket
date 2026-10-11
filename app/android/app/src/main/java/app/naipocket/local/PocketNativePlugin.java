package app.naipocket.local;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import androidx.activity.result.ActivityResult;
import android.app.Activity;
import java.io.File;
import java.io.FileInputStream;
import org.json.JSONArray;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ConcurrentHashMap;
import java.util.Set;
import java.net.HttpURLConnection;
import java.net.URL;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.Iterator;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "PocketNative", permissions = {
    @Permission(alias = "notifications", strings = { "android.permission.POST_NOTIFICATIONS" }),
    // Only Android 7-9 use it: the manifest declares it with maxSdkVersion=28.
    @Permission(alias = "storage", strings = { "android.permission.WRITE_EXTERNAL_STORAGE" })
})
public class PocketNativePlugin extends Plugin {
    private static final String KEY = "nai-pocket-vault-v1";
    private final ExecutorService vaultThread = Executors.newSingleThreadExecutor();
    private final ExecutorService galleryThread = Executors.newSingleThreadExecutor();
    private final ExecutorService networkThreads = Executors.newFixedThreadPool(4);
    private final ConcurrentHashMap<String, HttpURLConnection> requests = new ConcurrentHashMap<>();
    private final Set<String> cancelled = ConcurrentHashMap.newKeySet();
    private final Set<String> pendingRequests = ConcurrentHashMap.newKeySet();

    private File localFile(String path) throws Exception {
        if (path == null || path.startsWith("/") || path.contains("\\") || path.contains(":")) throw new IllegalArgumentException("Invalid local path");
        File base = getContext().getFilesDir().getCanonicalFile();
        File file = new File(base, path).getCanonicalFile();
        if (!file.getPath().startsWith(base.getPath() + File.separator)) throw new IllegalArgumentException("Invalid local path");
        return file;
    }

    @PluginMethod public void registerMedia(PluginCall call) {
        try {
            JSONArray entries = call.getArray("entries");
            if (entries == null || entries.length() > 5000) throw new IllegalArgumentException("Invalid media list");
            for (int i = 0; i < entries.length(); i++) {
                org.json.JSONObject item = entries.getJSONObject(i);
                String route = item.getString("route");
                if (!route.matches("/api/(images|assets)/[a-zA-Z0-9-]+/(original|preview|thumbnail)")) throw new IllegalArgumentException("Invalid media route");
                if (item.optBoolean("remove", false)) { PocketMediaClient.media.remove(route); continue; }
                String mime = item.getString("mime");
                if (!mime.matches("image/(png|jpeg|webp)")) throw new IllegalArgumentException("Invalid media type");
                File file = localFile(item.getString("path"));
                // Only media directories can be published into the WebView.
                String relative = item.getString("path");
                if (!relative.matches("(originals|thumbnails|previews|input-assets)/[a-zA-Z0-9_./-]+") || relative.contains("..")) throw new IllegalArgumentException("Invalid media path");
                PocketMediaClient.media.put(route, new PocketMediaClient.Entry(file, mime));
            }
            call.resolve();
        } catch (Exception error) { call.reject("本机图片路由无效。", error); }
    }

    @PluginMethod public void diskStatus(PluginCall call) {
        android.os.StatFs stats = new android.os.StatFs(getContext().getFilesDir().getPath());
        JSObject result = new JSObject(); result.put("freeBytes", stats.getAvailableBytes()); result.put("totalBytes", stats.getTotalBytes()); call.resolve(result);
    }

    @PluginMethod public void exportFile(PluginCall call) {
        String name = call.getString("name", "nai-image.png").replaceAll("[\\\\/:*?\"<>|]", "_");
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
            .setType(call.getString("mime", "application/octet-stream")).putExtra(Intent.EXTRA_TITLE, name);
        startActivityForResult(call, intent, "exportResult");
    }

    @ActivityCallback private void exportResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            JSObject response = new JSObject(); response.put("saved", false); call.resolve(response); return;
        }
        vaultThread.execute(() -> {
            try (java.io.OutputStream output = getContext().getContentResolver().openOutputStream(result.getData().getData())) {
                if (output == null) throw new java.io.IOException("No destination");
                String path = call.getString("path");
                if (path != null) { try (InputStream input = new FileInputStream(localFile(path))) { byte[] chunk = new byte[65536]; int count; while ((count = input.read(chunk)) != -1) output.write(chunk, 0, count); } }
                else output.write(Base64.decode(call.getString("data", ""), Base64.NO_WRAP));
                JSObject response = new JSObject(); response.put("saved", true); call.resolve(response);
            } catch (Exception error) { call.reject("文件导出失败。", error); }
        });
    }

    // Phone album copy (Pictures/NAI Pocket). Original bytes are copied as-is, never re-encoded.
    // Callers treat every outcome as non-fatal: the in-app gallery already holds the image.
    private static final String GALLERY_FOLDER = "NAI Pocket";

    private boolean legacyStorage() { return android.os.Build.VERSION.SDK_INT < 29; }

    private boolean inForeground() {
        Activity activity = getActivity();
        return activity instanceof androidx.lifecycle.LifecycleOwner
            && ((androidx.lifecycle.LifecycleOwner) activity).getLifecycle().getCurrentState().isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED);
    }

    private SharedPreferences permissionPreferences() { return getContext().getSharedPreferences("nai-pocket-permissions", Context.MODE_PRIVATE); }

    private void resolveGallery(PluginCall call, boolean saved, String reason) {
        JSObject response = new JSObject(); response.put("saved", saved); if (reason != null) response.put("reason", reason); call.resolve(response);
    }

    @PluginMethod public void requestGalleryAccess(PluginCall call) {
        if (!legacyStorage() || getPermissionState("storage") == PermissionState.GRANTED) { JSObject result = new JSObject(); result.put("granted", true); call.resolve(result); return; }
        if (!inForeground()) { JSObject result = new JSObject(); result.put("granted", false); call.resolve(result); return; }
        permissionPreferences().edit().putBoolean("galleryAsked", true).apply();
        requestPermissionForAlias("storage", call, "galleryAccessResult");
    }

    @PermissionCallback private void galleryAccessResult(PluginCall call) {
        JSObject result = new JSObject(); result.put("granted", getPermissionState("storage") == PermissionState.GRANTED); call.resolve(result);
    }

    @PluginMethod public void saveToGallery(PluginCall call) {
        if (legacyStorage() && getPermissionState("storage") != PermissionState.GRANTED) {
            // Ask once, and only while the app is on screen: Android 7-9 would otherwise
            // pop the system dialog over whatever the person is doing during a background queue.
            if (permissionPreferences().getBoolean("galleryAsked", false)) { resolveGallery(call, false, "permission-denied"); return; }
            if (!inForeground()) { resolveGallery(call, false, "permission-pending"); return; }
            permissionPreferences().edit().putBoolean("galleryAsked", true).apply();
            requestPermissionForAlias("storage", call, "galleryPermissionResult"); return;
        }
        galleryThread.execute(() -> writeToGallery(call));
    }

    @PermissionCallback private void galleryPermissionResult(PluginCall call) {
        if (getPermissionState("storage") != PermissionState.GRANTED) { resolveGallery(call, false, "permission-denied"); return; }
        galleryThread.execute(() -> writeToGallery(call));
    }

    private void copyGallerySource(PluginCall call, java.io.OutputStream output) throws Exception {
        String path = call.getString("path");
        if (path != null) {
            if (!path.matches("originals/[a-zA-Z0-9_./-]+") || path.contains("..")) throw new IllegalArgumentException("Invalid gallery source");
            try (InputStream input = new FileInputStream(localFile(path))) { byte[] chunk = new byte[65536]; int count; while ((count = input.read(chunk)) != -1) output.write(chunk, 0, count); }
        } else output.write(Base64.decode(call.getString("data", ""), Base64.NO_WRAP));
    }

    private void writeToGallery(PluginCall call) {
        String mime = call.getString("mime", "image/png");
        if (!mime.matches("image/(png|jpeg|webp)")) { call.reject("相册只接受 PNG / JPEG / WebP 图片。"); return; }
        String extension = mime.equals("image/webp") ? ".webp" : mime.equals("image/jpeg") ? ".jpg" : ".png";
        String name = call.getString("name", "nai-image" + extension).replaceAll("[\\\\/:*?\"<>|]", "_");
        if (!name.toLowerCase(java.util.Locale.ROOT).endsWith(extension)) name = name + extension;
        try {
            if (legacyStorage()) writeLegacyGallery(call, name, mime);
            else writeMediaStore(call, name, mime);
        } catch (Exception error) { call.reject("复制到手机相册失败。", error); }
    }

    private void writeMediaStore(PluginCall call, String name, String mime) throws Exception {
        android.content.ContentResolver resolver = getContext().getContentResolver();
        android.content.ContentValues values = new android.content.ContentValues();
        values.put(android.provider.MediaStore.Images.Media.DISPLAY_NAME, name);
        values.put(android.provider.MediaStore.Images.Media.MIME_TYPE, mime);
        values.put(android.provider.MediaStore.Images.Media.RELATIVE_PATH, android.os.Environment.DIRECTORY_PICTURES + "/" + GALLERY_FOLDER);
        values.put(android.provider.MediaStore.Images.Media.IS_PENDING, 1);
        android.net.Uri uri = resolver.insert(android.provider.MediaStore.Images.Media.getContentUri(android.provider.MediaStore.VOLUME_EXTERNAL_PRIMARY), values);
        if (uri == null) throw new java.io.IOException("MediaStore insert failed");
        try {
            try (java.io.OutputStream output = resolver.openOutputStream(uri)) {
                if (output == null) throw new java.io.IOException("No album destination");
                copyGallerySource(call, output);
            }
            android.content.ContentValues done = new android.content.ContentValues();
            done.put(android.provider.MediaStore.Images.Media.IS_PENDING, 0);
            resolver.update(uri, done, null, null);
        } catch (Exception error) {
            try { resolver.delete(uri, null, null); } catch (Exception ignored) {}
            throw error;
        }
        JSObject response = new JSObject(); response.put("saved", true); response.put("uri", uri.toString()); call.resolve(response);
    }

    @SuppressWarnings("deprecation")
    private void writeLegacyGallery(PluginCall call, String name, String mime) throws Exception {
        File folder = new File(android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_PICTURES), GALLERY_FOLDER);
        if (!folder.isDirectory() && !folder.mkdirs()) throw new java.io.IOException("Cannot create album folder");
        int dot = name.lastIndexOf('.');
        String base = name.substring(0, dot), extension = name.substring(dot);
        File target = new File(folder, name);
        for (int index = 1; target.exists(); index++) target = new File(folder, base + " (" + index + ")" + extension);
        try (java.io.OutputStream output = new java.io.FileOutputStream(target)) { copyGallerySource(call, output); }
        catch (Exception error) { target.delete(); throw error; }
        android.media.MediaScannerConnection.scanFile(getContext(), new String[] { target.getPath() }, new String[] { mime }, null);
        JSObject response = new JSObject(); response.put("saved", true); response.put("uri", android.net.Uri.fromFile(target).toString()); call.resolve(response);
    }

    @PluginMethod
    public void cancelRequest(PluginCall call) {
        String id = call.getString("id", "");
        if (pendingRequests.contains(id)) cancelled.add(id);
        HttpURLConnection request = requests.get(id);
        if (request != null) request.disconnect();
        call.resolve();
    }

    @PluginMethod
    public void request(PluginCall call) {
        String id = call.getString("id", "");
        pendingRequests.add(id);
        networkThreads.execute(() -> {
            HttpURLConnection connection = null;
            try {
                URL url = new URL(call.getString("url", ""));
                if (!url.getProtocol().equals("https") || url.getUserInfo() != null) throw new IllegalArgumentException("HTTPS required");
                connection = (HttpURLConnection) url.openConnection();
                requests.put(id, connection);
                if (cancelled.contains(id)) throw new InterruptedException();
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(30000);
                connection.setReadTimeout(300000);
                connection.setRequestMethod(call.getString("method", "GET"));
                JSObject headers = call.getObject("headers", new JSObject());
                Iterator<String> keys = headers.keys();
                while (keys.hasNext()) { String name = keys.next(); connection.setRequestProperty(name, headers.getString(name)); }
                String body = call.getString("body");
                if (body != null) {
                    byte[] bytes = Base64.decode(body, Base64.NO_WRAP);
                    connection.setDoOutput(true); connection.setFixedLengthStreamingMode(bytes.length);
                    try (java.io.OutputStream output = connection.getOutputStream()) { output.write(bytes); }
                }
                int status = connection.getResponseCode();
                JSObject responseHeaders = new JSObject();
                connection.getHeaderFields().forEach((name, values) -> { if (name != null) responseHeaders.put(name, String.join(", ", values)); });
                ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                InputStream input = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
                if (input != null) try (InputStream stream = input) {
                    byte[] chunk = new byte[65536]; int read;
                    while ((read = stream.read(chunk)) != -1) {
                        if (cancelled.contains(id)) throw new InterruptedException();
                        if (bytes.size() + read > 80 * 1024 * 1024) throw new java.io.IOException("Response too large");
                        bytes.write(chunk, 0, read);
                    }
                }
                if (cancelled.contains(id)) throw new InterruptedException();
                JSObject result = new JSObject(); result.put("status", status); result.put("headers", responseHeaders);
                result.put("body", Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP)); call.resolve(result);
            } catch (Exception error) {
                call.reject(cancelled.contains(id) ? "Request aborted" : "Native HTTP request failed", cancelled.contains(id) ? "ABORTED" : "NETWORK", error);
            } finally {
                requests.remove(id); pendingRequests.remove(id); cancelled.remove(id); if (connection != null) connection.disconnect();
            }
        });
    }

    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (!store.containsAlias(KEY)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(KEY, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
            generator.generateKey();
        }
        return (SecretKey) store.getKey(KEY, null);
    }

    @PluginMethod
    public void readVault(PluginCall call) {
        vaultThread.execute(() -> {
            try {
                SharedPreferences preferences = getContext().getSharedPreferences(KEY, Context.MODE_PRIVATE);
                String data = preferences.getString("data", "");
                String text = "{}";
                if (!data.isEmpty()) {
                    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                    cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(preferences.getString("iv", ""), Base64.NO_WRAP)));
                    text = new String(cipher.doFinal(Base64.decode(data, Base64.NO_WRAP)), StandardCharsets.UTF_8);
                }
                JSObject result = new JSObject(); result.put("value", text); call.resolve(result);
            } catch (Exception error) { call.reject("本机凭据无法解密，请重新配置 Token。", error); }
        });
    }

    @PluginMethod
    public void writeVault(PluginCall call) {
        String value = call.getString("value");
        if (value == null || value.length() > 1000000) { call.reject("凭据数据无效。"); return; }
        vaultThread.execute(() -> {
            try {
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key());
                String data = Base64.encodeToString(cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
                boolean saved = getContext().getSharedPreferences(KEY, Context.MODE_PRIVATE).edit()
                    .putString("data", data).putString("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP)).commit();
                if (!saved) throw new java.io.IOException("Vault write failed");
                call.resolve();
            } catch (Exception error) { call.reject("凭据保存失败。", error); }
        });
    }

    @PluginMethod
    public void queueActive(PluginCall call) {
        if (Boolean.TRUE.equals(call.getBoolean("active", false)) && android.os.Build.VERSION.SDK_INT >= 33
            && getPermissionState("notifications") != PermissionState.GRANTED
            && !getContext().getSharedPreferences("nai-pocket-permissions", Context.MODE_PRIVATE).getBoolean("notificationsAsked", false)) {
            getContext().getSharedPreferences("nai-pocket-permissions", Context.MODE_PRIVATE).edit().putBoolean("notificationsAsked", true).apply();
            requestPermissionForAlias("notifications", call, "notificationPermissionResult"); return;
        }
        applyQueueActive(call);
    }

    @PermissionCallback private void notificationPermissionResult(PluginCall call) { applyQueueActive(call); }

    private void applyQueueActive(PluginCall call) {
        try {
            Intent intent = new Intent(getContext(), PocketQueueService.class);
            if (Boolean.TRUE.equals(call.getBoolean("active", false))) {
                if (android.os.Build.VERSION.SDK_INT >= 26) getContext().startForegroundService(intent);
                else getContext().startService(intent);
            } else getContext().stopService(intent);
            call.resolve();
        } catch (Exception error) { call.reject("无法启用后台生成通知。", error); }
    }

    @Override
    protected void handleOnDestroy() {
        vaultThread.shutdown(); galleryThread.shutdown(); networkThreads.shutdownNow();
        requests.values().forEach(HttpURLConnection::disconnect);
    }
}
