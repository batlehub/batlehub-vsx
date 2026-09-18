package batlehub.jdt.core;

import java.util.function.Consumer;
import org.eclipse.jdt.core.dom.ASTNode;
import org.eclipse.jdt.core.dom.rewrite.ASTRewrite;

/** One occurrence: the node, the message, and the fix (null when none is safe). */
public record Finding(Inspection rule, ASTNode node, String message, String fixTitle, Consumer<ASTRewrite> fix) {}
