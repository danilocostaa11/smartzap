import { describe, it, expect, vi } from 'vitest'
import { selectInstallerProject, resolveInstallerProject } from './project-selection'

const projects = [
  { id: 'prj_v2', name: 'smartzapv2' },
  { id: 'prj_lia', name: 'smartzap-lia' },
  { id: 'prj_other', name: 'site' },
]

describe('selectInstallerProject', () => {
  it('uses VERCEL_PROJECT_ID exactly, never another smartzap project', () => {
    const r = selectInstallerProject(projects, { VERCEL_PROJECT_ID: 'prj_lia' })
    expect(r.ok && r.project.id).toBe('prj_lia')
  })

  it('does NOT fall back when VERCEL_PROJECT_ID is not in the list', () => {
    const r = selectInstallerProject(projects, { VERCEL_PROJECT_ID: 'prj_missing' })
    expect(r.ok).toBe(false)
  })

  it('requires exact VERCEL_PROJECT_NAME when set', () => {
    expect(selectInstallerProject(projects, { VERCEL_PROJECT_NAME: 'smartzap-lia' })).toMatchObject({ ok: true, project: { id: 'prj_lia' } })
    expect(selectInstallerProject(projects, { VERCEL_PROJECT_NAME: 'smartzap' }).ok).toBe(false)
  })

  it('keeps legacy behaviour only without env (local dev)', () => {
    expect(selectInstallerProject(projects, {})).toMatchObject({ ok: true, project: { id: 'prj_v2' }, reason: 'legacy' })
  })
})

describe('resolveInstallerProject', () => {
  it('fetches by id when not in the paginated list', async () => {
    const prev = process.env.VERCEL_PROJECT_ID
    process.env.VERCEL_PROJECT_ID = 'prj_far'
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: 'prj_far', name: 'smartzap-lia-02' }), { status: 200 }))
    const r = await resolveInstallerProject('t', projects, fetchImpl as unknown as typeof fetch)
    expect(r).toMatchObject({ ok: true, project: { id: 'prj_far' } })
    const fail = vi.fn(async () => new Response('{}', { status: 404 }))
    expect((await resolveInstallerProject('t', projects, fail as unknown as typeof fetch)).ok).toBe(false)
    if (prev === undefined) delete process.env.VERCEL_PROJECT_ID
    else process.env.VERCEL_PROJECT_ID = prev
  })
})
