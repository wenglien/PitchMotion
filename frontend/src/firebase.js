import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAnalytics } from "firebase/analytics";

const firebaseConfig = {
  apiKey:            "AIzaSyBGuEKTkLaTriUM7r87jRJ9pN0sgdY88Kc",
  authDomain:        "speedgun-cc0ab.firebaseapp.com",
  projectId:         "speedgun-cc0ab",
  storageBucket:     "speedgun-cc0ab.firebasestorage.app",
  messagingSenderId: "280989269814",
  appId:             "1:280989269814:web:71edfd4e43a26264b37d97",
  measurementId:     "G-EP56X1Q8RZ",
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);

if (typeof window !== "undefined") {
  getAnalytics(app);
}

export default app;
