import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: 'AIzaSyC0U0jrHcRr2mjg3ZnxtAGkfeQmyVgRev8',
  authDomain: 'value-vis.firebaseapp.com',
  projectId: 'value-vis',
  storageBucket: 'value-vis.firebasestorage.app',
  messagingSenderId: '497899663554',
  appId: '1:497899663554:web:75c55b2cca69b786fe4b5b',
  measurementId: 'G-EYFMRDPNLN',
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
export const googleProvider = new GoogleAuthProvider();
