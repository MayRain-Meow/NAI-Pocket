package app.naipocket.local;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PocketNativePlugin.class);
        registerPlugin(ArtistResourcesPlugin.class);
        super.onCreate(savedInstanceState);
        getBridge().setWebViewClient(new PocketMediaClient(getBridge()));
    }
}
