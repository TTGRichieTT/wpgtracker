package com.wpg.barracks;

import android.os.Bundle;
import android.webkit.CookieManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Streams tab: Twitch and YouTube chat run inside the page and need their own sign-in cookies,
        // which Android blocks by default.
        CookieManager.getInstance().setAcceptThirdPartyCookies(getBridge().getWebView(), true);
    }

    // Android only writes web cookies to storage every so often; save them whenever the app
    // is closed or sent to the background so members stay signed in.
    @Override
    public void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }

    @Override
    public void onStop() {
        super.onStop();
        CookieManager.getInstance().flush();
    }
}
