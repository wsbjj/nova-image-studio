import { beforeEach, describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TextToImageForm } from '../TextToImageForm'

describe('TextToImageForm', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('nova-model-registry', JSON.stringify({
      imageModels: [{
        id: 'gpt-image-2',
        protocol: 'openai',
        name: 'GPT Image 2',
        modelId: 'gpt-image-2',
        apiKey: 'test-api-key',
        baseUrl: 'https://api.openai.com',
        builtinPreset: 'gpt-image-2',
        maxRefImages: 16,
        maxOutputSize: '4K',
        supportsAdvancedParams: true,
      }],
      textModels: [],
      defaults: {
        textToImage: 'gpt-image-2',
        imageToImage: 'gpt-image-2',
        reversePrompt: '',
        agent: '',
        promptOptimize: '',
        imageDescribe: '',
      },
    }))
  })

  it('renders the form with placeholder text', () => {
    const onSubmit = vi.fn()
    render(<TextToImageForm onSubmit={onSubmit} />)

    expect(screen.getByPlaceholderText('描述你想要生成的图像...')).toBeInTheDocument()
  })

  it('submit button is disabled when prompt is empty', () => {
    const onSubmit = vi.fn()
    render(<TextToImageForm onSubmit={onSubmit} />)

    const submitButton = screen.getByRole('button', { name: '' }) // Arrow icon button
    expect(submitButton).toBeDisabled()
  })

  it('submit button is enabled when prompt has text', () => {
    const onSubmit = vi.fn()
    render(<TextToImageForm onSubmit={onSubmit} />)

    const textarea = screen.getByPlaceholderText('描述你想要生成的图像...')
    fireEvent.change(textarea, { target: { value: 'A beautiful sunset' } })

    const submitButton = screen.getByRole('button', { name: '' })
    expect(submitButton).not.toBeDisabled()
  })

  it('calls onSubmit with prompt when Shift+Enter is pressed', () => {
    const onSubmit = vi.fn()
    render(<TextToImageForm onSubmit={onSubmit} />)

    const textarea = screen.getByPlaceholderText('描述你想要生成的图像...')
    fireEvent.change(textarea, { target: { value: 'A beautiful sunset' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      prompts: ['A beautiful sunset'],
      outputSize: '1K',
      aspectRatio: '1:1',
      temperature: 1,
      model: 'gemini-3-pro-image-preview',
      gptImageQuality: 'auto',
      gptImageStyle: 'auto',
      gptImageBackground: 'auto',
      parallelCount: 1,
    }))
  })

  it('shows image params control for GPT Image 2 model', async () => {
    const onSubmit = vi.fn()
    render(<TextToImageForm onSubmit={onSubmit} initialData={{ model: 'gpt-image-2' }} />)

    expect(await screen.findByTitle('图像参数')).toBeInTheDocument()
  })

  it('submits default image params for GPT Image 2 model when left on auto', async () => {
    const onSubmit = vi.fn()
    render(
      <TextToImageForm
        onSubmit={onSubmit}
        initialData={{ model: 'gpt-image-2', prompt: 'Cut out the subject' }}
      />
    )

    const textarea = screen.getByPlaceholderText('描述你想要生成的图像...')
    await screen.findByTitle('图像参数')
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-image-2',
      gptImageQuality: 'auto',
      gptImageStyle: 'auto',
      gptImageBackground: 'auto',
    }))
  })

  it('does NOT submit when plain Enter is pressed', () => {
    const onSubmit = vi.fn()
    render(<TextToImageForm onSubmit={onSubmit} />)

    const textarea = screen.getByPlaceholderText('描述你想要生成的图像...')
    fireEvent.change(textarea, { target: { value: 'A beautiful sunset' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })

    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('shows configuration prompt when disabled prop is true', () => {
    const onSubmit = vi.fn()
    render(<TextToImageForm onSubmit={onSubmit} disabled />)

    expect(screen.getByText('API 密钥未配置')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '配置' })).toBeInTheDocument()
  })
})
