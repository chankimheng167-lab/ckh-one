'use client';
import type { ReactNode } from 'react';
import { AppShell } from './AppShell';

/** Every signed-in screen is wrapped in the shell (navigation, offline and sync indicators). */
export const Authed = ({ children }: { children: ReactNode }) => <AppShell>{children}</AppShell>;
