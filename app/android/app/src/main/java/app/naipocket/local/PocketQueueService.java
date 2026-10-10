package app.naipocket.local;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

// Keeps the process important during a user-started local queue. The shared JS
// worker owns jobs and restart recovery; this service never resubmits requests.
public class PocketQueueService extends Service {
    private PowerManager.WakeLock wakeLock;
    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String channel = "nai-pocket-generation";
        if (Build.VERSION.SDK_INT >= 26) getSystemService(NotificationManager.class)
            .createNotificationChannel(new NotificationChannel(channel, "本地生成队列", NotificationManager.IMPORTANCE_LOW));
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, channel) : new Notification.Builder(this);
        startForeground(1, builder.setContentTitle("NAI Pocket 正在生成")
            .setContentText("点击查看队列；可在应用中暂停或取消。")
            .setSmallIcon(android.R.drawable.ic_menu_gallery).setContentIntent(open).setOngoing(true).build());
        if (wakeLock == null) {
            wakeLock = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "NAIPocket:Generation");
            wakeLock.setReferenceCounted(false);
        }
        wakeLock.acquire(10 * 60 * 1000L);
        return START_NOT_STICKY;
    }
    @Override public void onTimeout(int startId, int fgsType) { stopSelf(); }
    @Override public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
