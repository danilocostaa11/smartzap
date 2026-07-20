import { Page, PageDescription, PageHeader, PageTitle, PageActions } from '@/components/ui/page'
import { Container } from '@/components/ui/container'

/**
 * Skeleton de Contatos para Suspense/Streaming.
 */
export function ContactsSkeleton() {
  return (
    <Page className="flex flex-col h-full min-h-0">
      <PageHeader>
        <div>
          <PageTitle>Contatos</PageTitle>
          <PageDescription>Gerencie sua audiência, listas e tags</PageDescription>
        </div>
        <PageActions className="flex-wrap justify-start sm:justify-end">
          <div className="flex items-center gap-2">
            <div className="h-10 w-10 bg-zinc-800 rounded-lg animate-pulse" />
            <div className="h-10 w-40 bg-zinc-800 rounded-lg animate-pulse" />
          </div>
          <div className="h-10 w-32 bg-primary-600/50 rounded-lg animate-pulse" />
        </PageActions>
      </PageHeader>

      {/* Stats Row Skeleton */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-20 bg-zinc-800/50 rounded-xl animate-pulse" />
        ))}
      </div>

      <Container variant="glass" padding="none" className="rounded-2xl flex-1 min-h-0 flex flex-col">
        {/* Filters Skeleton */}
        <div className="p-4 border-b border-white/5 flex gap-3">
          <div className="flex-1 h-10 bg-zinc-800/50 rounded-lg animate-pulse" />
          <div className="h-10 w-32 bg-zinc-800/50 rounded-lg animate-pulse" />
          <div className="h-10 w-32 bg-zinc-800/50 rounded-lg animate-pulse" />
        </div>

        {/* Table Skeleton */}
        <div className="flex-1 p-4">
          <div className="space-y-2">
            {/* Header */}
            <div className="h-10 bg-zinc-800/30 rounded animate-pulse" />
            {/* Rows */}
            {[...Array(8)].map((_, i) => (
              <div key={i} className="h-14 bg-zinc-800/20 rounded animate-pulse" />
            ))}
          </div>
        </div>

        {/* Pagination Skeleton */}
        <div className="p-4 border-t border-white/5 flex justify-center gap-2">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-8 w-8 bg-zinc-800/50 rounded animate-pulse" />
          ))}
        </div>
      </Container>
    </Page>
  )
}
