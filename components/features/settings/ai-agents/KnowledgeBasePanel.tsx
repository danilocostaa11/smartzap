'use client'

/**
 * T062: KnowledgeBasePanel
 * File list with upload, site import, and status badges for AI agent knowledge base
 */

import React, { useState, useCallback, useRef } from 'react'
import {
  FileText,
  Upload,
  Trash2,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Clock,
  XCircle,
  HardDrive,
  Globe,
  RefreshCw,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { AIKnowledgeFile, KnowledgeFileIndexingStatus } from '@/types'

export interface KnowledgeBasePanelProps {
  agentId: string | null
  files: AIKnowledgeFile[]
  isLoading: boolean
  error: Error | null
  onUpload: (params: { name: string; content: string; mime_type?: string }) => Promise<AIKnowledgeFile>
  onImportUrl?: (url: string) => Promise<AIKnowledgeFile>
  onReindex?: (fileId: string) => Promise<AIKnowledgeFile>
  onDelete: (fileId: string) => Promise<void>
  isUploading?: boolean
  isImportingUrl?: boolean
  isReindexing?: boolean
  isDeleting?: boolean
  totalSize?: number
}

function getIndexError(file: AIKnowledgeFile): string | null {
  const uri = file.external_file_uri
  if (uri?.startsWith('index_error:')) {
    return uri.slice('index_error:'.length)
  }
  return null
}

const statusConfig: Record<KnowledgeFileIndexingStatus, { label: string; icon: React.ElementType; color: string }> = {
  pending: { label: 'Aguardando', icon: Clock, color: 'text-yellow-400' },
  processing: { label: 'Processando', icon: Loader2, color: 'text-blue-400' },
  completed: { label: 'Indexado', icon: CheckCircle2, color: 'text-emerald-400' },
  failed: { label: 'Falhou', icon: XCircle, color: 'text-red-400' },
  local_only: { label: 'Local', icon: HardDrive, color: 'text-zinc-400' },
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function KnowledgeBasePanel({
  agentId,
  files,
  isLoading,
  error,
  onUpload,
  onImportUrl,
  onReindex,
  onDelete,
  isUploading = false,
  isImportingUrl = false,
  isReindexing = false,
  isDeleting = false,
  totalSize = 0,
}: KnowledgeBasePanelProps) {
  const [isDragOver, setIsDragOver] = useState(false)
  const [deleteFile, setDeleteFile] = useState<AIKnowledgeFile | null>(null)
  const [reindexingId, setReindexingId] = useState<string | null>(null)
  const [siteDialogOpen, setSiteDialogOpen] = useState(false)
  const [siteUrl, setSiteUrl] = useState('')
  const [siteError, setSiteError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const busy = isUploading || isImportingUrl || isReindexing

  // Handle file selection
  const handleFileSelect = useCallback(
    async (file: File) => {
      if (!agentId) return

      try {
        // Determinar se é arquivo binário (PDF, imagens) ou texto
        const binaryTypes = [
          'application/pdf',
          'image/',
          'application/vnd.openxmlformats', // docx, pptx, xlsx
        ]
        const isBinary = binaryTypes.some((t) => file.type.startsWith(t))

        let content: string

        if (isBinary) {
          // Para binários: ler como data URL (base64)
          content = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(reader.result as string)
            reader.onerror = () => reject(reader.error)
            reader.readAsDataURL(file)
          })
        } else {
          // Para texto: ler como string UTF-8
          content = await file.text()
        }

        await onUpload({
          name: file.name,
          content,
          mime_type: file.type || 'text/plain',
        })
      } catch (err) {
        console.error('[KnowledgeBasePanel] Upload error:', err)
      }
    },
    [agentId, onUpload]
  )

  // Handle drag events
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
  }, [])

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      setIsDragOver(false)

      const droppedFiles = Array.from(e.dataTransfer.files)
      for (const file of droppedFiles) {
        await handleFileSelect(file)
      }
    },
    [handleFileSelect]
  )

  // Handle input change
  const handleInputChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const selectedFiles = Array.from(e.target.files || [])
      for (const file of selectedFiles) {
        await handleFileSelect(file)
      }
      // Reset input
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    },
    [handleFileSelect]
  )

  // Handle delete confirmation
  const handleConfirmDelete = useCallback(async () => {
    if (deleteFile) {
      await onDelete(deleteFile.id)
      setDeleteFile(null)
    }
  }, [deleteFile, onDelete])

  const handleImportSite = useCallback(async () => {
    if (!onImportUrl || !siteUrl.trim()) return

    setSiteError(null)
    try {
      await onImportUrl(siteUrl.trim())
      setSiteDialogOpen(false)
      setSiteUrl('')
    } catch (err) {
      setSiteError(err instanceof Error ? err.message : 'Erro ao importar site')
    }
  }, [onImportUrl, siteUrl])

  const handleReindex = useCallback(
    async (fileId: string) => {
      if (!onReindex) return
      setReindexingId(fileId)
      try {
        await onReindex(fileId)
      } catch (err) {
        console.error('[KnowledgeBasePanel] Reindex error:', err)
        alert(err instanceof Error ? err.message : 'Erro ao reindexar')
      } finally {
        setReindexingId(null)
      }
    },
    [onReindex]
  )

  if (!agentId) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Base de Conhecimento</CardTitle>
          <CardDescription>
            Selecione um agente para gerenciar sua base de conhecimento
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <TooltipProvider>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="p-2 rounded-lg bg-blue-500/10">
                <FileText className="h-5 w-5 text-blue-400" />
              </div>
              <div className="min-w-0">
                <CardTitle className="text-base">Base de Conhecimento</CardTitle>
                <CardDescription>
                  {files.length} arquivo{files.length !== 1 ? 's' : ''} • {formatFileSize(totalSize)}
                </CardDescription>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {onImportUrl && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setSiteError(null)
                    setSiteDialogOpen(true)
                  }}
                  disabled={busy}
                >
                  {isImportingUrl ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Globe className="h-4 w-4 mr-2" />
                  )}
                  Adicionar site
                </Button>
              )}
              <Button
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy}
              >
                {isUploading ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Upload className="h-4 w-4 mr-2" />
                )}
                Adicionar
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                accept=".txt,.md,.pdf,.csv,.json"
                multiple
                onChange={handleInputChange}
              />
            </div>
          </div>
        </CardHeader>

        <CardContent>
          {/* Loading state */}
          {isLoading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
            </div>
          )}

          {/* Error state */}
          {error && !isLoading && (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <AlertCircle className="h-6 w-6 text-red-400 mb-2" />
              <p className="text-sm text-zinc-400">Erro ao carregar arquivos</p>
              <p className="text-xs text-zinc-500">{error.message}</p>
            </div>
          )}

          {/* Drop zone / Empty state */}
          {!isLoading && !error && files.length === 0 && (
            <div
              className={cn(
                'flex flex-col items-center justify-center py-8 border-2 border-dashed rounded-lg transition-colors',
                isDragOver
                  ? 'border-primary-500 bg-primary-500/5'
                  : 'border-zinc-800 hover:border-zinc-700'
              )}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              <Upload className="h-8 w-8 text-zinc-500 mb-3" />
              <p className="text-sm text-zinc-400 mb-1">
                Arraste arquivos, clique em &quot;Adicionar&quot; ou importe um site
              </p>
              <p className="text-xs text-zinc-500">
                Arquivos: TXT, MD, PDF, CSV, JSON · Site: até 15 páginas do mesmo domínio
              </p>
            </div>
          )}

          {/* File list */}
          {!isLoading && !error && files.length > 0 && (
            <div
              className={cn(
                'space-y-2 rounded-lg transition-colors',
                isDragOver && 'ring-2 ring-primary-500 bg-primary-500/5'
              )}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              {files.map((file) => {
                const status = statusConfig[file.indexing_status]
                const StatusIcon = status.icon
                const isSite = file.name.startsWith('site:')
                const indexError = getIndexError(file)
                const fileReindexing = reindexingId === file.id

                return (
                  <div
                    key={file.id}
                    className="flex items-center justify-between gap-3 p-3 rounded-lg bg-zinc-800/50 border border-zinc-700/50"
                  >
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <div className="p-2 rounded bg-zinc-700/50">
                        {isSite ? (
                          <Globe className="h-4 w-4 text-zinc-400" />
                        ) : (
                          <FileText className="h-4 w-4 text-zinc-400" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-zinc-200 truncate">
                          {file.name}
                        </p>
                        <p className="text-xs text-zinc-500">
                          {formatFileSize(file.size_bytes)}
                          {file.chunks_count > 0 ? ` · ${file.chunks_count} chunks` : ''}
                        </p>
                        {indexError && file.indexing_status === 'failed' && (
                          <p className="text-xs text-red-400 mt-1 line-clamp-2" title={indexError}>
                            {indexError}
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      {/* Status badge */}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div className={cn('flex items-center gap-1 px-1', status.color)}>
                            <StatusIcon
                              className={cn(
                                'h-4 w-4',
                                (file.indexing_status === 'processing' || fileReindexing) &&
                                  'animate-spin'
                              )}
                            />
                          </div>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>{status.label}</p>
                        </TooltipContent>
                      </Tooltip>

                      {onReindex &&
                        (file.indexing_status === 'failed' ||
                          file.indexing_status === 'completed') && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-zinc-400 hover:text-emerald-400"
                                onClick={() => void handleReindex(file.id)}
                                disabled={busy}
                              >
                                {fileReindexing ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <RefreshCw className="h-4 w-4" />
                                )}
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>Reindexar</p>
                            </TooltipContent>
                          </Tooltip>
                        )}

                      {/* Delete button */}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-zinc-400 hover:text-red-400"
                        onClick={() => setDeleteFile(file)}
                        disabled={isDeleting || busy}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Import site dialog */}
      <Dialog
        open={siteDialogOpen}
        onOpenChange={(open) => {
          if (isImportingUrl) return
          setSiteDialogOpen(open)
          if (!open) {
            setSiteError(null)
            setSiteUrl('')
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Adicionar site</DialogTitle>
            <DialogDescription>
              Indexa até 15 páginas do mesmo domínio a partir da URL informada.
              Pode levar alguns minutos.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="site-url">URL do site</Label>
            <Input
              id="site-url"
              type="url"
              placeholder="https://seusite.com.br"
              value={siteUrl}
              onChange={(e) => setSiteUrl(e.target.value)}
              disabled={isImportingUrl}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && siteUrl.trim() && !isImportingUrl) {
                  e.preventDefault()
                  void handleImportSite()
                }
              }}
            />
            {siteError && (
              <p className="text-sm text-red-400">{siteError}</p>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setSiteDialogOpen(false)}
              disabled={isImportingUrl}
            >
              Cancelar
            </Button>
            <Button
              onClick={() => void handleImportSite()}
              disabled={!siteUrl.trim() || isImportingUrl}
            >
              {isImportingUrl ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Importando...
                </>
              ) : (
                <>
                  <Globe className="h-4 w-4 mr-2" />
                  Importar
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteFile} onOpenChange={() => setDeleteFile(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir arquivo?</AlertDialogTitle>
            <AlertDialogDescription>
              Tem certeza que deseja excluir &ldquo;{deleteFile?.name}&rdquo;?
              Esta ação não pode ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              className="bg-red-600 hover:bg-red-700"
              disabled={isDeleting}
            >
              {isDeleting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Excluindo...
                </>
              ) : (
                'Excluir'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  )
}
