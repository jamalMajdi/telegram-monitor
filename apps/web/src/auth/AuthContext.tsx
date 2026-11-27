import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { authApi, setAccessToken, setCsrfToken, type SessionUser } from '../api/client';

interface AuthState {
  user: SessionUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, displayName: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  const bootstrap = useCallback(async () => {
    try {
      const data = await authApi.session();
      if (data.authenticated && data.user) {
        setUser(data.user);
        setCsrfToken(data.csrfToken ?? null);
      } else {
        setUser(null);
        setCsrfToken(null);
      }
    } catch {
      setUser(null);
      setCsrfToken(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  const login = useCallback(async (email: string, password: string) => {
    const data = await authApi.login({ email, password });
    setCsrfToken(data.csrfToken);
    setAccessToken(data.accessToken ?? null);
    setUser(data.user);
  }, []);

  const register = useCallback(async (email: string, displayName: string, password: string) => {
    const data = await authApi.register({ email, displayName, password });
    setCsrfToken(data.csrfToken);
    setAccessToken(data.accessToken ?? null);
    setUser(data.user);
  }, []);

  /**
   * الخروج محلي دائماً: حتى إن فشل طلب الخادم (جلسة منتهية، رمز CSRF قديم، أو حجب
   * ملف تعريف الارتباط في بيئة معاينة) نُفرّغ الحالة ونعيد المستخدم إلى شاشة الدخول،
   * فلا يبقى زر الخروج بلا أثر مرئي.
   */
  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } catch {
      // تجاهل متعمّد: الهدف إسقاط الحالة المحلية بأي حال.
    } finally {
      setCsrfToken(null);
      setAccessToken(null);
      setUser(null);
    }
  }, []);

  const value = useMemo<AuthState>(
    () => ({ user, loading, login, register, logout, refresh: bootstrap }),
    [user, loading, login, register, logout, bootstrap],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth يجب أن يُستخدم داخل AuthProvider');
  return ctx;
}
