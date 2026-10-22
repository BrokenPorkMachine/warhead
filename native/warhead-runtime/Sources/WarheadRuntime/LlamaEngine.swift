import Foundation
import LlamaSwift
import MLXLMCommon

struct LlamaMessage {
    let role: String
    let content: String
}

/// In-process GGUF inference through llama.cpp. The model template comes from
/// the GGUF metadata, which also lets imported Ollama blobs run without their
/// daemon or a generated Modelfile.
final class LlamaEngine {
    private let model: OpaquePointer
    private let context: OpaquePointer
    private let vocab: OpaquePointer
    private let contextTokenLimit: Int

    /// llama.cpp's backend is process-global. Initializing it per engine and
    /// freeing it in `deinit` breaks model replacement: the new engine is
    /// created before the old one is released, so the old `deinit` would free
    /// the backend the new engine is about to use. Keep it alive for the
    /// process instead; the OS reclaims it on exit.
    private static let backendInitialized: Bool = {
        llama_backend_init()
        return true
    }()

    init(path: String) throws {
        _ = Self.backendInitialized
        var modelParams = llama_model_default_params()
        modelParams.n_gpu_layers = 99
        guard let loaded = path.withCString({ llama_model_load_from_file($0, modelParams) }) else {
            throw LlamaEngineError.modelLoad(path)
        }
        let trainedContext = max(1, Int(llama_model_n_ctx_train(loaded)))
        contextTokenLimit = min(trainedContext, 32_768)
        var contextParams = llama_context_default_params()
        contextParams.n_ctx = UInt32(contextTokenLimit)
        contextParams.n_batch = 512
        guard let created = llama_init_from_model(loaded, contextParams) else {
            llama_model_free(loaded)
            throw LlamaEngineError.contextCreate
        }
        model = loaded
        context = created
        vocab = llama_model_get_vocab(loaded)
    }

    deinit {
        llama_free(context)
        llama_model_free(model)
    }

    func generate(
        messages: [LlamaMessage],
        tools: [[String: AnyCodable]],
        requestID: Int,
        maxTokens: Int
    ) throws {
        let toolSpecs: [ToolSpec] = tools.compactMap { wrapped in
            var result: [String: any Sendable] = [:]
            for (key, value) in wrapped {
                guard let converted = llamaSendable(value.value) else { return nil }
                result[key] = converted
            }
            return result
        }
        var conversation = messages
        if !toolSpecs.isEmpty {
            let rawTools = tools.map { $0.mapValues(\.value) }
            let encoded = try JSONSerialization.data(withJSONObject: rawTools)
            let text = String(decoding: encoded, as: UTF8.self)
            if let index = conversation.firstIndex(where: { $0.role == "system" }) {
                conversation[index] = LlamaMessage(role: "system", content: conversation[index].content + "\n\nAvailable tools (call only using a JSON tool_call):\n" + text)
            } else {
                conversation.insert(LlamaMessage(role: "system", content: "Available tools (call only using a JSON tool_call):\n" + text), at: 0)
            }
        }
        let prompt = try applyTemplate(conversation)
        llama_memory_clear(llama_get_memory(context), true)
        let promptTokens = tokenize(prompt)
        guard !promptTokens.isEmpty else { throw LlamaEngineError.tokenize }
        guard promptTokens.count <= contextTokenLimit else {
            throw LlamaEngineError.contextLength(contextTokenLimit)
        }
        var batch = llama_batch_init(512, 0, 1)
        defer { llama_batch_free(batch) }
        var promptOffset = 0
        while promptOffset < promptTokens.count {
            let count = min(512, promptTokens.count - promptOffset)
            batch.n_tokens = Int32(count)
            for offset in 0..<count {
                let position = promptOffset + offset
                batch.token[offset] = promptTokens[position]
                batch.pos[offset] = Int32(position)
                batch.n_seq_id[offset] = 1
                if let seqIDs = batch.seq_id, let seqID = seqIDs[offset] { seqID[0] = 0 }
                batch.logits[offset] = position == promptTokens.count - 1 ? 1 : 0
            }
            guard llama_decode(context, batch) == 0 else { throw LlamaEngineError.decode }
            promptOffset += count
        }

        let samplerParams = llama_sampler_chain_default_params()
        let sampler = llama_sampler_chain_init(samplerParams)
        defer { llama_sampler_free(sampler) }
        llama_sampler_chain_add(sampler, llama_sampler_init_temp(0.7))
        llama_sampler_chain_add(sampler, llama_sampler_init_dist(UInt32.random(in: 1...UInt32.max)))

        var processor = toolSpecs.isEmpty ? nil : ToolCallProcessor(format: .json, tools: toolSpecs)
        var pendingBytes: [UInt8] = []
        var generated = 0
        // Leave room for the prompt: decoding past n_ctx fails on most builds.
        let remaining = contextTokenLimit - promptTokens.count
        guard remaining > 0 else { throw LlamaEngineError.contextLength(contextTokenLimit) }
        let generationLimit = max(1, min(maxTokens, remaining))
        for _ in 0..<generationLimit {
            let token = llama_sampler_sample(sampler, context, -1)
            if llama_vocab_is_eog(vocab, token) { break }
            llama_sampler_accept(sampler, token)
            var piece = [CChar](repeating: 0, count: 128)
            var length = llama_token_to_piece(vocab, token, &piece, Int32(piece.count), 0, false)
            if length < 0 {
                piece = [CChar](repeating: 0, count: Int(-length))
                length = llama_token_to_piece(vocab, token, &piece, Int32(piece.count), 0, false)
            }
            if length > 0 {
                pendingBytes.append(contentsOf: piece.prefix(Int(length)).map { UInt8(bitPattern: $0) })
                if let text = String(bytes: pendingBytes, encoding: .utf8) {
                    pendingBytes.removeAll(keepingCapacity: true)
                    let visible = processor.map { $0.processChunk(text) ?? "" } ?? text
                    if !visible.isEmpty { emit(requestID, "text", ["delta": visible]) }
                }
            }
            batch.n_tokens = 1
            batch.token[0] = token
            batch.pos[0] = Int32(promptTokens.count + generated)
            batch.n_seq_id[0] = 1
            if let seqIDs = batch.seq_id, let seqID = seqIDs[0] { seqID[0] = 0 }
            batch.logits[0] = 1
            generated += 1
            guard llama_decode(context, batch) == 0 else { throw LlamaEngineError.decode }
        }
        if !pendingBytes.isEmpty {
            let text = String(decoding: pendingBytes, as: UTF8.self)
            let visible = processor.map { $0.processChunk(text) ?? "" } ?? text
            if !visible.isEmpty { emit(requestID, "text", ["delta": visible]) }
        }
        if let trailing = processor?.processEOS(returnBufferedText: true), !trailing.isEmpty {
            emit(requestID, "text", ["delta": trailing])
        }
        for call in processor?.toolCalls ?? [] {
            let encoded = try JSONEncoder().encode(call.function.arguments)
            let arguments = (try JSONSerialization.jsonObject(with: encoded)) as? [String: Any] ?? [:]
            emit(requestID, "tool_call", ["call": [
                "id": call.id ?? UUID().uuidString,
                "name": call.function.name,
                "args": arguments,
            ]])
        }
        emit(requestID, "done", ["evalCount": generated, "promptEvalCount": promptTokens.count])
    }

    private func applyTemplate(_ messages: [LlamaMessage]) throws -> String {
        guard let template = llama_model_chat_template(model, nil) else {
            throw LlamaEngineError.noChatTemplate
        }
        let rolePointers = messages.map { strdup($0.role) }
        let contentPointers = messages.map { strdup($0.content) }
        defer {
            rolePointers.forEach { free($0) }
            contentPointers.forEach { free($0) }
        }
        var wire = messages.indices.map { index in
            llama_chat_message(role: rolePointers[index], content: contentPointers[index])
        }
        let needed = llama_chat_apply_template(template, &wire, wire.count, true, nil, 0)
        guard needed > 0 else { throw LlamaEngineError.template }
        var buffer = [CChar](repeating: 0, count: Int(needed) + 1)
        let written = llama_chat_apply_template(template, &wire, wire.count, true, &buffer, Int32(buffer.count))
        guard written >= 0, written <= buffer.count else { throw LlamaEngineError.template }
        return String(decoding: buffer.prefix(Int(written)).map { UInt8(bitPattern: $0) }, as: UTF8.self)
    }

    private func tokenize(_ text: String) -> [llama_token] {
        let capacity = text.utf8.count + 8
        var tokens = [llama_token](repeating: 0, count: capacity)
        var count = llama_tokenize(vocab, text, Int32(text.utf8.count), &tokens, Int32(capacity), true, true)
        // A negative result is llama.cpp reporting the buffer it needs, which
        // can exceed the byte count when special tokens are added.
        if count < 0 {
            let needed = Int(-count)
            tokens = [llama_token](repeating: 0, count: needed)
            count = llama_tokenize(vocab, text, Int32(text.utf8.count), &tokens, Int32(needed), true, true)
        }
        guard count > 0 else { return [] }
        return Array(tokens.prefix(Int(count)))
    }
}

private enum LlamaEngineError: Error, LocalizedError {
    case modelLoad(String), contextCreate, tokenize, contextLength(Int), decode, sampler, noChatTemplate, template
    var errorDescription: String? {
        switch self {
        case .modelLoad(let path): return "llama.cpp could not load GGUF model at \(path)"
        case .contextCreate: return "llama.cpp could not create the inference context"
        case .tokenize: return "llama.cpp could not tokenize the prompt"
        case .contextLength(let limit): return "prompt exceeds this GGUF model's context limit (\(limit) tokens); shorten or compact the conversation"
        case .decode: return "llama.cpp failed while decoding tokens"
        case .sampler: return "llama.cpp could not create a sampler"
        case .noChatTemplate: return "GGUF model has no embedded chat template"
        case .template: return "llama.cpp could not apply the GGUF chat template"
        }
    }
}

private func llamaSendable(_ value: Any) -> (any Sendable)? {
    if value is NSNull { return NSNull() }
    if let value = value as? String { return value }
    if let value = value as? NSNumber { return value }
    if let values = value as? [Any] {
        let converted = values.compactMap(llamaSendable)
        return converted.count == values.count ? converted : nil
    }
    if let values = value as? [String: Any] {
        var converted: [String: any Sendable] = [:]
        for (key, value) in values {
            guard let item = llamaSendable(value) else { return nil }
            converted[key] = item
        }
        return converted
    }
    return nil
}
