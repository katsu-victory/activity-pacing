// public/firebase-messaging-sw.js
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

const firebaseConfig = {
  apiKey: "AIzaSyArq5xGeVpI3vwEnL5XXBFmteYjiDaRN3E",
  authDomain: "activity-pacing.firebaseapp.com",
  projectId: "activity-pacing",
  storageBucket: "activity-pacing.firebasestorage.app",
  messagingSenderId: "927081046826",
  appId: "1:927081046826:web:e742e5d0e5e31348c17453",
  measurementId: "G-FZMXHRBY59"
};

firebase.initializeApp(firebaseConfig);

const messaging = firebase.messaging();

// バックグラウンド通知の受信処理
messaging.onBackgroundMessage((payload) => {
  console.log('[firebase-messaging-sw.js] Received background message ', payload);
  const notificationTitle = payload.notification.title;
  const notificationOptions = {
    body: payload.notification.body,
    icon: '/icon.png' // アイコン画像のパス
  };

  self.registration.showNotification(notificationTitle, notificationOptions);
});