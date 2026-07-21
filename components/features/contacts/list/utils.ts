import Papa from 'papaparse';

/**
 * Calculate relative time string from a date
 * @param dateString - ISO date string
 * @returns Human-readable relative time in Portuguese
 */
export const calculateRelativeTime = (dateString: string): string => {
  const date = new Date(dateString);
  const now = new Date();
  const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (diffInSeconds < 60) return 'agora';
  if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)}m atrás`;
  if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)}h atrás`;
  if (diffInSeconds < 604800) return `${Math.floor(diffInSeconds / 86400)}d atrás`;
  return date.toLocaleDateString('pt-BR');
};

/**
 * Parse CSV content into headers and rows
 * @param content - Raw CSV string content
 * @returns Object with headers array and rows array
 */
export const parseCSV = (content: string): { headers: string[]; rows: string[][] } => {
  const parsed = Papa.parse(content, { header: false, skipEmptyLines: true });
  const data = parsed.data as string[][];
  return {
    headers: data[0] || [],
    rows: data.slice(1)
  };
};

/**
 * Extrai só dígitos do telefone para importação CSV.
 *
 * NÃO prefixa "+" aqui: `+1199…` (DDD+celular sem 55) é interpretado como
 * país +1 (EUA) pelo libphonenumber e falha na validação WhatsApp.
 * A normalização E.164 (+55…) fica a cargo de `processPhoneNumber` no service.
 *
 * @param phone - Número bruto da planilha (ex: 11997793856)
 * @returns Apenas dígitos, ou string vazia
 */
export const formatPhoneNumber = (phone: string): string => {
  return phone.replace(/\D/g, '');
};

/**
 * Get initials from a name or phone
 * @param name - Contact name or phone
 * @returns Two character initials in uppercase
 */
export const getContactInitials = (name: string): string => {
  return name.substring(0, 2).toUpperCase();
};
