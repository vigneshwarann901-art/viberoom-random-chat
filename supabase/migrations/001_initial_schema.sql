-- STREAMING_CHUNK:Configuring PostgreSQL extensions and user profiles table...
-- ============================================================================
-- VibeRoom 2.0 — Supabase PostgreSQL Schema, RLS Policies & Functions
-- Run this migration in the Supabase SQL Editor for your project.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------------------------------------------------------------------------
-- 1. USER PROFILES TABLE
-- Linked 1:1 with auth.users. Stores display name, optional avatar, optional
-- self-declared gender, and match preference. Email is never stored here or
-- exposed publicly.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL CHECK (char_length(trim(display_name)) BETWEEN 2 AND 32),
  avatar_url TEXT CHECK (avatar_url IS NULL OR char_length(avatar_url) <= 500),
  gender TEXT CHECK (
    gender IS NULL OR gender IN ('woman', 'man', 'non_binary', 'prefer_not_to_say')
  ),
  match_preference TEXT NOT NULL DEFAULT 'anyone' CHECK (
    match_preference IN ('women', 'men', 'non_binary', 'anyone')
  ),
  profile_completed BOOLEAN NOT NULL DEFAULT FALSE,
  -- Server-managed privilege columns (protected from client updates via trigger)
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'moderator', 'admin')),
  premium_entitled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_profiles_gender_pref
  ON public.profiles (gender, match_preference);

-- STREAMING_CHUNK:Defining profile privilege guard and user creation triggers...
-- Automatically maintain updated_at and enforce privilege immutability for non-service-role callers
CREATE OR REPLACE FUNCTION public.handle_profile_write_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := NOW();
  NEW.display_name := trim(NEW.display_name);

  -- Compute profile_completed based on non-empty display_name
  IF char_length(NEW.display_name) >= 2 THEN
    NEW.profile_completed := TRUE;
  ELSE
    NEW.profile_completed := FALSE;
  END IF;

  -- Prevent authenticated clients from escalating their own role, entitlement, or immutable metadata
  IF current_setting('request.jwt.claim.role', true) IS DISTINCT FROM 'service_role' THEN
    IF TG_OP = 'INSERT' THEN
      NEW.role := 'user';
      NEW.premium_entitled := FALSE;
      NEW.created_at := NOW();
    ELSIF TG_OP = 'UPDATE' THEN
      NEW.id := OLD.id;
      NEW.role := OLD.role;
      NEW.premium_entitled := OLD.premium_entitled;
      NEW.created_at := OLD.created_at;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_profiles_write_guard ON public.profiles;
CREATE TRIGGER trg_profiles_write_guard
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_profile_write_guard();

-- Auto-create an initial profile row when a new user signs up in auth.users
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  initial_name TEXT;
BEGIN
  initial_name := COALESCE(
    NULLIF(trim(NEW.raw_user_meta_data->>'display_name'), ''),
    NULLIF(trim(NEW.raw_user_meta_data->>'full_name'), ''),
    'Viber_' || substr(replace(NEW.id::text, '-', ''), 1, 6)
  );
  initial_name := left(initial_name, 32);

  INSERT INTO public.profiles (
    id,
    display_name,
    gender,
    match_preference,
    profile_completed
  )
  VALUES (
    NEW.id,
    initial_name,
    NULL,
    'anyone',
    FALSE
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_auth_user();

-- STREAMING_CHUNK:Creating user blocklist, safety reports, and credit ledger tables...
-- ----------------------------------------------------------------------------
-- 2. PERSISTENT USER BLOCKLIST TABLE
-- Ensures blocked users are never paired across future sessions or devices.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_blocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  blocker_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  blocked_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_user_blocks_pair UNIQUE (blocker_id, blocked_id),
  CONSTRAINT chk_no_self_block CHECK (blocker_id <> blocked_id)
);

CREATE INDEX IF NOT EXISTS idx_user_blocks_blocker ON public.user_blocks (blocker_id);
CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON public.user_blocks (blocked_id);

-- ----------------------------------------------------------------------------
-- 3. PERSISTENT SAFETY REPORTS TABLE
-- Stores moderation reports privately. If an account is deleted, ON DELETE SET NULL
-- preserves the safety audit record until retention_expires_at (90 days).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.safety_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_code TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL CHECK (char_length(session_id) BETWEEN 3 AND 64),
  reporter_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reported_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL CHECK (
    reason IN ('inappropriate', 'underage', 'harassment', 'spam', 'violence')
  ),
  details TEXT CHECK (details IS NULL OR char_length(details) <= 500),
  status TEXT NOT NULL DEFAULT 'open' CHECK (
    status IN ('open', 'reviewed', 'resolved', 'dismissed')
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retention_expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '90 days')
);

CREATE INDEX IF NOT EXISTS idx_safety_reports_reported ON public.safety_reports (reported_id);
CREATE INDEX IF NOT EXISTS idx_safety_reports_retention ON public.safety_reports (retention_expires_at);

-- ----------------------------------------------------------------------------
-- 4. FUTURE CREDIT LEDGER (APPEND-ONLY TRANSACTION LOG)
-- Prepared for future credit-based matching entitlements without activating
-- payments or trusting client-supplied balances.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.credit_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  delta INTEGER NOT NULL CHECK (delta <> 0),
  transaction_type TEXT NOT NULL CHECK (
    transaction_type IN ('beta_grant', 'purchase', 'match_spend', 'refund', 'admin_adjustment')
  ),
  reference_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_credit_ledger_user ON public.credit_ledger (user_id, created_at DESC);

-- Server-side credit balance calculation function
CREATE OR REPLACE FUNCTION public.get_user_credit_balance(target_user_id UUID DEFAULT auth.uid())
RETURNS INTEGER
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  requesting_uid UUID := auth.uid();
BEGIN
  -- This SECURITY DEFINER function must not expose another user's balance.
  IF current_setting('request.jwt.claim.role', true) IS DISTINCT FROM 'service_role'
     AND (requesting_uid IS NULL OR requesting_uid IS DISTINCT FROM target_user_id) THEN
    RAISE EXCEPTION 'Not authorized to view this balance';
  END IF;

  RETURN (
    SELECT COALESCE(SUM(delta), 0)::INTEGER
    FROM public.credit_ledger
    WHERE user_id = target_user_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_user_credit_balance(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_user_credit_balance(UUID) TO authenticated, service_role;

-- STREAMING_CHUNK:Configuring account deletion RPC and Row Level Security policies...
-- ----------------------------------------------------------------------------
-- 5. SELF-SERVICE ACCOUNT DELETION RPC
-- Allows an authenticated user to permanently delete their own account and
-- cascading profile/blocks/ledger rows even if the server only has ANON_KEY.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.delete_own_account()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  calling_uid UUID;
BEGIN
  calling_uid := auth.uid();
  IF calling_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  DELETE FROM auth.users WHERE id = calling_uid;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_own_account() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_own_account() TO authenticated;

-- ----------------------------------------------------------------------------
-- 6. ROW LEVEL SECURITY (RLS) POLICIES
-- Users can never read or modify other users' profiles, blocks, reports, or
-- ledger entries.
-- ----------------------------------------------------------------------------
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.safety_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_ledger ENABLE ROW LEVEL SECURITY;

-- Profiles: Users can only read, insert, update, or delete their own profile row
DROP POLICY IF EXISTS "profiles_select_own" ON public.profiles;
CREATE POLICY "profiles_select_own"
  ON public.profiles FOR SELECT
  TO authenticated
  USING (auth.uid() = id);

DROP POLICY IF EXISTS "profiles_insert_own" ON public.profiles;
CREATE POLICY "profiles_insert_own"
  ON public.profiles FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
CREATE POLICY "profiles_update_own"
  ON public.profiles FOR UPDATE
  TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "profiles_delete_own" ON public.profiles;
CREATE POLICY "profiles_delete_own"
  ON public.profiles FOR DELETE
  TO authenticated
  USING (auth.uid() = id);

-- User Blocks: Users can only view, create, or remove their own blocks
DROP POLICY IF EXISTS "user_blocks_select_own" ON public.user_blocks;
CREATE POLICY "user_blocks_select_own"
  ON public.user_blocks FOR SELECT
  TO authenticated
  USING (auth.uid() = blocker_id);

DROP POLICY IF EXISTS "user_blocks_insert_own" ON public.user_blocks;
CREATE POLICY "user_blocks_insert_own"
  ON public.user_blocks FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = blocker_id AND blocker_id <> blocked_id);

DROP POLICY IF EXISTS "user_blocks_delete_own" ON public.user_blocks;
CREATE POLICY "user_blocks_delete_own"
  ON public.user_blocks FOR DELETE
  TO authenticated
  USING (auth.uid() = blocker_id);

-- Safety Reports: Authenticated users can submit reports as themselves,
-- but CANNOT read, update, or delete reports (strictly private to moderation/service_role).
DROP POLICY IF EXISTS "safety_reports_insert_own" ON public.safety_reports;
CREATE POLICY "safety_reports_insert_own"
  ON public.safety_reports FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = reporter_id AND reporter_id <> reported_id);

-- Credit Ledger: Authenticated users can view their own ledger history,
-- but can NEVER insert, update, or delete ledger transactions from the client.
DROP POLICY IF EXISTS "credit_ledger_select_own" ON public.credit_ledger;
CREATE POLICY "credit_ledger_select_own"
  ON public.credit_ledger FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);