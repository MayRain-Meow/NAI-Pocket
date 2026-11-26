package app.naipocket.local;

public final class PocketMediaRoutesTest {
    public static void main(String[] args) {
        for (String tier : new String[] { "original", "preview", "thumbnail" }) {
            accepted("/api/images/image-123/" + tier);
            accepted("/api/images/trash/image-123/" + tier);
            accepted("/api/assets/asset-123/" + tier);
        }
        for (String route : new String[] {
            null, "", "/api/images/trash", "/api/images/trash//preview",
            "/api/assets/trash/image-123/original", "/api/images/trash/image-123/metadata",
            "/api/images/../original", "/api/images/trash/../preview",
            "/api/images/trash/%2e%2e/original", "/api/images/trash/image_123/preview",
            "/api/images/trash/image-123/preview/extra", "/api/images/trash/image-123/preview?x=1",
            "https://localhost/api/images/trash/image-123/original",
            "/api/images/trash/image-123/thumbnail\n"
        }) {
            if (PocketMediaRoutes.isValid(route)) throw new AssertionError("Accepted invalid route: " + route);
        }
        System.out.println("PASS native gallery, trash, asset routes and invalid-route rejection");
    }

    private static void accepted(String route) {
        if (!PocketMediaRoutes.isValid(route)) throw new AssertionError("Rejected media route: " + route);
    }
}
