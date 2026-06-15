
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyArq5xGeVpI3vwEnL5XXBFmteYjiDaRN3E",
    authDomain: "activity-pacing.firebaseapp.com",
    projectId: "activity-pacing",
    storageBucket: "activity-pacing.firebasestorage.app",
    messagingSenderId: "927081046826",
    appId: "1:927081046826:web:e742e5d0e5e31348c17453",
    measurementId: "G-FZMXHRBY59"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Global exposure for app.js
window.FirebaseApp = { app, auth, db, doc, getDoc, setDoc, config: firebaseConfig };
console.log("Firebase Config Loaded");
