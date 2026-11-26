package app.naipocket.local;

import java.util.regex.Pattern;

// Keep the bridge allowlist separate so the real Android contract can run in plain JVM tests.
final class PocketMediaRoutes {
    static final String ROUTE_PATTERN = "/api/(images/(trash/)?|assets/)[a-zA-Z0-9-]+/(original|preview|thumbnail)";
    private static final Pattern ROUTE = Pattern.compile(ROUTE_PATTERN);

    private PocketMediaRoutes() {}

    static boolean isValid(String route) {
        return route != null && ROUTE.matcher(route).matches();
    }
}
