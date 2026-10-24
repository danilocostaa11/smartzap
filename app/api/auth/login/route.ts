/**
 * Login API
 * 
 * POST: Login with password
 */

import { NextRequest, NextResponse } from 'next/server'
import { loginUser, isSetupComplete } from '@/lib/user-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function loginErrorStatus(error?: string): number {
  if (!error) return 401
  if (
    error.includes('Banco de dados') ||
    error.includes('persistir sessão') ||
    error.includes('indisponível')
  ) {
    return 503
  }
  return 401
}

export async function POST(request: NextRequest) {
  try {
    const setupComplete = await isSetupComplete()
    if (!setupComplete) {
      return NextResponse.json(
        { error: 'Setup não concluído', needsSetup: true },
        { status: 400 }
      )
    }
    
    const body = await request.json()
    const { password } = body
    if (!password) {
      return NextResponse.json(
        { error: 'Senha é obrigatória' },
        { status: 400 }
      )
    }
    
    const result = await loginUser(password)
    
    if (!result.success) {
      return NextResponse.json(
        { error: result.error },
        { status: loginErrorStatus(result.error) }
      )
    }
    
    return NextResponse.json({
      success: true,
      company: result.company
    })
    
  } catch (error) {
    console.error('Login error:', error)
    return NextResponse.json(
      { error: 'Erro ao fazer login' },
      { status: 500 }
    )
  }
}
