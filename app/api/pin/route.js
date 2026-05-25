import { db } from '../../../lib/firebase';
import { doc, getDoc, setDoc } from 'firebase/firestore';

export async function POST(req) {
  const { user, pin, action } = await req.json();
  if (!user || !pin) return Response.json({ ok: false, error: 'Missing fields' }, { status: 400 });

  const ref = doc(db, 'ist_permits_pins', user);

  if (action === 'set') {
    // Set or update PIN
    await setDoc(ref, { pin, updatedAt: new Date().toISOString() });
    return Response.json({ ok: true });
  }

  // Default: verify PIN
  const snap = await getDoc(ref);
  if (!snap.exists()) return Response.json({ ok: false, needsSetup: true });
  return Response.json({ ok: snap.data().pin === pin });
}

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const user = searchParams.get('user');
  if (!user) return Response.json({ hasPin: false });

  const snap = await getDoc(doc(db, 'ist_permits_pins', user));
  return Response.json({ hasPin: snap.exists() });
}
