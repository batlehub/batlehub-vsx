package batlehub.jdt.core.inspections;

import batlehub.jdt.core.Finding;
import java.util.List;
import org.eclipse.jdt.core.dom.AST;
import org.eclipse.jdt.core.dom.ASTVisitor;
import org.eclipse.jdt.core.dom.BooleanLiteral;
import org.eclipse.jdt.core.dom.CompilationUnit;
import org.eclipse.jdt.core.dom.Expression;
import org.eclipse.jdt.core.dom.InfixExpression;
import org.eclipse.jdt.core.dom.ParenthesizedExpression;
import org.eclipse.jdt.core.dom.PrefixExpression;

/** `x == true` → `x`; `x == false` / `x != true` → `!x`. */
public final class BooleanLiteralComparison extends Base {
  public BooleanLiteralComparison() {
    super("style", "booleanLiteralComparison", "info");
  }

  @Override
  public void visit(CompilationUnit cu, List<Finding> out) {
    cu.accept(new ASTVisitor() {
      @Override
      public boolean visit(InfixExpression e) {
        if (e.hasExtendedOperands() || e.getOperator() != InfixExpression.Operator.EQUALS && e.getOperator() != InfixExpression.Operator.NOT_EQUALS) return true;
        BooleanLiteral lit = e.getRightOperand() instanceof BooleanLiteral b ? b : e.getLeftOperand() instanceof BooleanLiteral b2 ? b2 : null;
        if (lit == null) return true;
        Expression other = lit == e.getRightOperand() ? e.getLeftOperand() : e.getRightOperand();
        boolean negate = lit.booleanValue() != (e.getOperator() == InfixExpression.Operator.EQUALS);
        out.add(new Finding(BooleanLiteralComparison.this, e, "Comparison with a boolean literal", "Replace with " + (negate ? "!" : "") + other, rw -> {
          AST ast = e.getAST();
          Expression copy = (Expression) rw.createCopyTarget(other);
          if (!negate) {
            rw.replace(e, copy, null);
            return;
          }
          PrefixExpression not = ast.newPrefixExpression();
          not.setOperator(PrefixExpression.Operator.NOT);
          if (other instanceof org.eclipse.jdt.core.dom.Name || other instanceof org.eclipse.jdt.core.dom.MethodInvocation || other instanceof org.eclipse.jdt.core.dom.FieldAccess || other instanceof ParenthesizedExpression) not.setOperand(copy);
          else {
            ParenthesizedExpression p = ast.newParenthesizedExpression();
            p.setExpression(copy);
            not.setOperand(p);
          }
          rw.replace(e, not, null);
        }));
        return true;
      }
    });
  }
}
