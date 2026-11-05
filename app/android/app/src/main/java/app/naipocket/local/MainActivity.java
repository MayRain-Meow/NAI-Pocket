package app.naipocket.local;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    private static boolean crashNoteInstalled = false;
    @Override public void onCreate(Bundle savedInstanceState) {
        // A Java crash leaves a note for the next start (BootRecord), then crashes as before.
        if (!crashNoteInstalled) {
            crashNoteInstalled = true;
            final android.content.Context context = getApplicationContext();
            final Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
            Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
                try { BootRecord.nativeCrash(context, thread, error); } catch (Throwable ignored) {}
                if (previous != null) previous.uncaughtException(thread, error);
            });
        }
        registerPlugin(PocketNativePlugin.class);
        registerPlugin(ArtistResourcesPlugin.class);
        registerPlugin(AppUpdatePlugin.class);
        registerPlugin(StyleEmbedPlugin.class);
        super.onCreate(savedInstanceState);
        getBridge().setWebViewClient(new PocketMediaClient(getBridge()));
    }
}
