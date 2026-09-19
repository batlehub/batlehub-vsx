package batlehub.jdt.core.inspections;

import batlehub.jdt.core.Finding;
import java.util.List;
import org.eclipse.jdt.core.dom.ASTNode;
import org.eclipse.jdt.core.dom.ASTVisitor;
import org.eclipse.jdt.core.dom.Assignment;
import org.eclipse.jdt.core.dom.CompilationUnit;
import org.eclipse.jdt.core.dom.DoStatement;
import org.eclipse.jdt.core.dom.EnhancedForStatement;
import org.eclipse.jdt.core.dom.Expression;
import org.eclipse.jdt.core.dom.ForStatement;
import org.eclipse.jdt.core.dom.InfixExpression;
import org.eclipse.jdt.core.dom.StringLiteral;
import org.eclipse.jdt.core.dom.WhileStatement;

/**
 * `s += "…"` or `s = s + "…"` inside a loop: a StringBuilder is what the
 * author wants. No fix — the rewrite touches the variable's declaration and
 * every later read; that is a refactoring, not a quick fix.
 */
public final class StringConcatInLoop extends Base {
  public StringConcatInLoop() {
    super("performance", "stringConcatInLoop", "warning");
  }

  @Override
  public void visit(CompilationUnit cu, List<Finding> out) {
    cu.accept(new ASTVisitor() {
      @Override
      public boolean visit(Assignment a) {
        if (!inLoop(a)) return true;
        boolean concat = a.getOperator() == Assignment.Operator.PLUS_ASSIGN && hasStringLiteral(a.getRightHandSide())
            || a.getOperator() == Assignment.Operator.ASSIGN && a.getRightHandSide() instanceof InfixExpression ie && ie.getOperator() == InfixExpression.Operator.PLUS
                && ie.getLeftOperand().toString().equals(a.getLeftHandSide().toString()) && hasStringLiteral(ie);
        if (concat) out.add(new Finding(StringConcatInLoop.this, a, "String concatenation in a loop: use a StringBuilder", null, null));
        return true;
      }
    });
  }

  private static boolean hasStringLiteral(Expression e) {
    if (e instanceof StringLiteral) return true;
    if (e instanceof InfixExpression ie) {
      if (hasStringLiteral(ie.getLeftOperand()) || hasStringLiteral(ie.getRightOperand())) return true;
      for (Object o : ie.extendedOperands()) if (hasStringLiteral((Expression) o)) return true;
    }
    return false;
  }

  private static boolean inLoop(ASTNode n) {
    for (ASTNode p = n.getParent(); p != null; p = p.getParent()) {
      if (p instanceof ForStatement || p instanceof EnhancedForStatement || p instanceof WhileStatement || p instanceof DoStatement) return true;
      if (p instanceof org.eclipse.jdt.core.dom.MethodDeclaration) return false;
    }
    return false;
  }
}
