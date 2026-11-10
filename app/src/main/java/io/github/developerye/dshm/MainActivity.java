package io.github.developerye.dshm;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.ValueCallback;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * DSH Mobile — a one-activity WebView shell.
 *
 * The UI ships inside the APK (assets/www) but is served to the WebView as if it
 * lived on the DSH origin: requests under {@link #PREFIX} are answered locally by
 * {@link #shouldInterceptRequest}, everything else goes to the real server. That
 * keeps the document same-origin with the DSH API, so cookies, fetch and the
 * remote.mux WebSocket all behave exactly like the browser client — no CORS
 * shim, no proxying, and the shell paints without any network round trip.
 */
public class MainActivity extends Activity {

    /** Every locally served path lives under this prefix on the DSH origin. */
    private static final String PREFIX = "/__app/";
    private static final String ASSET_ROOT = "www";
    private static final String DEFAULT_SERVER = "http://36.138.189.24:3080";
    private static final String PREFS = "dshm";

    private WebView web;
    private static final int REQ_FILE_CHOOSER = 4017;
    private ValueCallback<Uri[]> filePathCallback;
    private SharedPreferences prefs;

    private static final Map<String, String> MIME = new HashMap<String, String>();
    static {
        MIME.put("html", "text/html");
        MIME.put("js", "text/javascript");
        MIME.put("css", "text/css");
        MIME.put("json", "application/json");
        MIME.put("svg", "image/svg+xml");
        MIME.put("png", "image/png");
        MIME.put("webmanifest", "application/manifest+json");
    }

    @SuppressLint("SetJavaScriptEnabled")
    @Override

    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);

        getWindow().setStatusBarColor(Color.parseColor("#0f1115"));
        getWindow().setNavigationBarColor(Color.parseColor("#0f1115"));

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0f1115"));
        web.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setTextZoom(100);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            s.setSafeBrowsingEnabled(false);
        }

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(web, true);

        web.setWebViewClient(new ShellClient());
        web.setWebChromeClient(new WebChromeClient() {
            /**
             * Android ignores <input type="file"> unless this is implemented; the page
             * then looks like it has no upload button at all. params.createIntent()
             * already carries the page's accept types and the multiple flag.
             */
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                }
                filePathCallback = callback;
                Intent intent = null;
                try {
                    intent = params.createIntent();
                } catch (Exception ignored) {
                }
                if (intent == null) {
                    intent = new Intent(Intent.ACTION_GET_CONTENT);
                    intent.setType("*/*");
                }
                try {
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                } catch (Exception ignored) {
                }
                try {
                    startActivityForResult(Intent.createChooser(intent, "选择文件"), REQ_FILE_CHOOSER);
                } catch (Exception e) {
                    filePathCallback = null;
                    return false;
                }
                return true;
            }
        });
        web.addJavascriptInterface(new Bridge(), "DSHMAndroid");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        setContentView(web);
        web.loadUrl(server() + PREFIX + "index.html");
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE_CHOOSER) {
            if (filePathCallback != null) {
                Uri[] result = null;
                if (resultCode == Activity.RESULT_OK && data != null) {
                    ClipData clip = data.getClipData();
                    if (clip != null) {
                        int n = clip.getItemCount();
                        result = new Uri[n];
                        for (int i = 0; i < n; i++) {
                            result[i] = clip.getItemAt(i).getUri();
                        }
                    } else if (data.getData() != null) {
                        result = new Uri[] { data.getData() };
                    }
                }
                filePathCallback.onReceiveValue(result);
                filePathCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    private String server() {
        String v = prefs.getString("server", DEFAULT_SERVER);
        if (v == null || v.isEmpty()) return DEFAULT_SERVER;
        while (v.endsWith("/")) v = v.substring(0, v.length() - 1);
        return v;
    }

    /** JS bridge: lets the in-app settings screen move the shell to another instance. */
    private class Bridge {
        @JavascriptInterface
        public String getServer() {
            return server();
        }

        /**
         * Copy through the platform clipboard. The page is served over plain http, where
         * "navigator.clipboard" does not exist, so copy actions would silently fail
         * without this bridge.
         */
        @JavascriptInterface
        public void copy(final String text) {
            final String value = text == null ? "" : text;
            runOnUiThread(new Runnable() {
                public void run() {
                    ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                    if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("DSH", value));
                }
            });
        }

        @JavascriptInterface
        public void setServer(final String url) {
            if (url == null || url.isEmpty()) return;
            prefs.edit().putString("server", url).apply();
            runOnUiThread(new Runnable() {
                public void run() {
                    String s = url;
                    while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
                    web.loadUrl(s + PREFIX + "index.html");
                }
            });
        }
    }

    private class ShellClient extends WebViewClient {

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            String path = u.getPath();
            if (path == null || !path.startsWith(PREFIX)) return null;

            String rel = path.substring(PREFIX.length());
            if (rel.isEmpty()) rel = "index.html";
            if (rel.contains("..")) return text(403, "forbidden");

            String ext = rel.contains(".") ? rel.substring(rel.lastIndexOf('.') + 1).toLowerCase() : "";
            String mime = MIME.get(ext);
            if (mime == null) mime = "application/octet-stream";

            try {
                InputStream in = getAssets().open(ASSET_ROOT + "/" + rel);
                WebResourceResponse r = new WebResourceResponse(mime, "utf-8", in);
                Map<String, String> h = new HashMap<String, String>();
                // Local assets are versioned by the APK itself.
                h.put("Cache-Control", "no-cache");
                r.setResponseHeaders(h);
                return r;
            } catch (IOException e) {
                return text(404, "missing " + rel);
            }
        }

        private WebResourceResponse text(int code, String body) {
            Map<String, String> h = new HashMap<String, String>();
            return new WebResourceResponse("text/plain", "utf-8", code, "err", h,
                    new ByteArrayInputStream(body.getBytes()));
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            String scheme = u.getScheme() == null ? "" : u.getScheme();
            String host = u.getHost() == null ? "" : u.getHost();
            String current = Uri.parse(server()).getHost();
            if (host != null && host.equals(current)) return false;         // stay in-app
            if ("http".equals(scheme) || "https".equals(scheme)) {           // external → browser
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (Exception ignored) {
                }
                return true;
            }
            return false;
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        // Let the web UI decide: chat → list → exit.
        web.evaluateJavascript(
                "(function(){try{return window.__DSHM__&&window.__DSHM__.back?window.__DSHM__.back():'exit'}catch(e){return 'exit'}})()",
                value -> {
                    if (value == null || value.contains("exit")) {
                        super.onBackPressed();
                    }
                });
    }
}
