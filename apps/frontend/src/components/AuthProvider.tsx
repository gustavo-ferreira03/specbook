"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { AuthUser } from "@/lib/types";

interface AuthState {
    user: AuthUser | null;
    loading: boolean;
    isAdmin: boolean;
    canEdit: boolean;
    refresh: () => Promise<AuthUser | null>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
    const [user, setUser] = useState<AuthUser | null>(null);
    const [loading, setLoading] = useState(true);
    const refresh = useCallback(async () => {
        try {
            const result = await api<{ user: AuthUser }>("/auth/me");
            setUser(result.user);
            return result.user;
        } catch (error) {
            if (error instanceof ApiError && error.status === 401) { setUser(null); return null; }
            throw error;
        } finally { setLoading(false); }
    }, []);
    useEffect(() => { void refresh().catch(() => undefined); }, [refresh]);
    const value = useMemo(() => ({ user, loading, isAdmin: user?.role === "admin", canEdit: user?.role === "admin" || user?.role === "editor", refresh }), [user, loading, refresh]);
    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
    const state = useContext(AuthContext);
    if (!state) throw new Error("AuthProvider is required");
    return state;
}
